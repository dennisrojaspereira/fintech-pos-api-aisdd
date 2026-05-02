/**
 * Acquirer Adapter — Opossum circuit breaker em volta de AcquirerClient.
 *
 * Source: design.md "Acquirer Adapter" + requirements 1.6, 3.4 (+1.1, 8.2).
 *
 * Escopo desta task (6.2):
 *   - Envolve `AcquirerClient` (Task 6.1) com `opossum` v8 separadamente
 *     para `authorize` e `void` (dois breakers — falha em authorize não
 *     deve fechar a janela de void e vice-versa).
 *   - Configuração:
 *       timeout: env.ACQUIRER_TIMEOUT_MS (default 25_000)
 *       errorThresholdPercentage: 50
 *       resetTimeout: 30_000
 *       rollingCountTimeout: 10_000
 *   - API:
 *       authorize(req): Promise<Result<AcquirerResult, AcquirerAdapterError>>
 *       void(req):      Promise<Result<AcquirerResult, AcquirerAdapterError>>
 *
 *   - Comportamento crítico:
 *     • O client subjacente NUNCA throw — retorna `AcquirerResult` com
 *       outcome 'TIMEOUT' / 'ERROR'. Para o breaker observar timeouts
 *       (e abrir o circuito após N falhas), usamos `breaker.fire(fn)`
 *       passando uma fn interna que TRANSFORMA `outcome === 'TIMEOUT'`
 *       em uma exceção sentinel `BREAKER_TIMEOUT_FOR_OPOSSUM`. Esta
 *       exceção é capturada pelo adapter, mapeada de volta para
 *       `ok({ outcome: 'TIMEOUT', ... })` e NÃO propagada.
 *     • `errorFilter` é configurado para NÃO ignorar a sentinel — assim
 *       o circuito conta timeouts como falhas e abre após o threshold.
 *     • Se o breaker estiver aberto (ou opossum lançar
 *       `Error: Breaker is open`), retornamos
 *       `err({ code: 'CIRCUIT_OPEN', httpStatus: 503, retryAfterSeconds: 30 })`.
 *
 *   - Métricas: integração `opossum-prometheus` quando `prom-client`
 *     estiver disponível (peer-dep). Falhas de import são silenciadas
 *     (TODO: melhorar quando prom-client for adicionado como dep direta).
 *
 * Requirements: 1.6, 3.4 (+ 1.1, 8.2).
 */

import CircuitBreaker from 'opossum';
import { createRequire } from 'node:module';

import { loadEnv, type AppEnv } from '../../config/env.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  AcquirerAdapterError,
  AcquirerAuthRequest,
  AcquirerResult,
  AcquirerVoidRequest,
} from '../../shared/types.js';
import {
  AcquirerClient,
  acquirerClient as defaultClient,
} from './acquirer-client.js';

const ERROR_THRESHOLD_PERCENTAGE = 50;
const RESET_TIMEOUT_MS = 30_000;
const ROLLING_COUNT_TIMEOUT_MS = 10_000;
const RETRY_AFTER_SECONDS = 30;

/**
 * Sentinel error usada para fazer o opossum "ver" um TIMEOUT do client.
 * O client em si nunca lança; convertemos timeouts no wrapper.
 */
const BREAKER_TIMEOUT_SENTINEL = 'BREAKER_TIMEOUT_FOR_OPOSSUM';

/**
 * Mensagens que o opossum usa quando o circuito está aberto. Mantemos
 * uma lista para defense-in-depth — o flag `breaker.opened` é a fonte
 * primária.
 */
const CIRCUIT_OPEN_MESSAGES = ['Breaker is open', 'is open'];

interface AcquirerAdapterOptions {
  readonly env?: AppEnv;
  readonly client?: AcquirerClient;
  /** Override útil em testes — pula a integração prometheus. */
  readonly disablePrometheus?: boolean;
}

type AuthorizeFn = (req: AcquirerAuthRequest) => Promise<AcquirerResult>;
type VoidFn = (req: AcquirerVoidRequest) => Promise<AcquirerResult>;

export class AcquirerAdapter {
  private readonly env: AppEnv;
  private readonly client: AcquirerClient;
  private readonly authorizeBreaker: CircuitBreaker<
    [AcquirerAuthRequest],
    AcquirerResult
  >;
  private readonly voidBreaker: CircuitBreaker<
    [AcquirerVoidRequest],
    AcquirerResult
  >;

  public constructor(options: AcquirerAdapterOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.client = options.client ?? defaultClient;

    const baseOptions: CircuitBreaker.Options = {
      timeout: this.env.ACQUIRER_TIMEOUT_MS,
      errorThresholdPercentage: ERROR_THRESHOLD_PERCENTAGE,
      resetTimeout: RESET_TIMEOUT_MS,
      rollingCountTimeout: ROLLING_COUNT_TIMEOUT_MS,
      // Retornar `true` ignora o erro (não conta como falha). Aqui não
      // ignoramos nada — todos os erros (sentinel + inesperados) contam
      // como falhas para abrir o circuito.
      errorFilter: (_error: unknown): boolean => false,
    };

    const wrappedAuthorize: AuthorizeFn = async (req) => {
      const result = await this.client.authorize(req);
      if (result.outcome === 'TIMEOUT') {
        const ex = new Error(BREAKER_TIMEOUT_SENTINEL);
        (ex as Error & { acquirerResult?: AcquirerResult }).acquirerResult =
          result;
        throw ex;
      }
      return result;
    };

    const wrappedVoid: VoidFn = async (req) => {
      const result = await this.client.void(req);
      if (result.outcome === 'TIMEOUT') {
        const ex = new Error(BREAKER_TIMEOUT_SENTINEL);
        (ex as Error & { acquirerResult?: AcquirerResult }).acquirerResult =
          result;
        throw ex;
      }
      return result;
    };

    this.authorizeBreaker = new CircuitBreaker<
      [AcquirerAuthRequest],
      AcquirerResult
    >(wrappedAuthorize, baseOptions);
    this.voidBreaker = new CircuitBreaker<
      [AcquirerVoidRequest],
      AcquirerResult
    >(wrappedVoid, baseOptions);

    if (!options.disablePrometheus) {
      tryAttachPrometheusMetrics([this.authorizeBreaker, this.voidBreaker]);
    }
  }

  /**
   * Autoriza uma transação atravessando o circuit breaker.
   *   - Sucesso (APPROVED/DECLINED/ERROR) → ok(result).
   *   - Timeout do client → ok({ outcome: 'TIMEOUT', ... }) (sem propagar).
   *   - Circuito aberto → err({ code: 'CIRCUIT_OPEN', ... }).
   */
  public async authorize(
    req: AcquirerAuthRequest,
  ): Promise<Result<AcquirerResult, AcquirerAdapterError>> {
    return this.runBreaker(this.authorizeBreaker, req);
  }

  /**
   * Cancela (void) uma transação atravessando o circuit breaker.
   */
  public async void(
    req: AcquirerVoidRequest,
  ): Promise<Result<AcquirerResult, AcquirerAdapterError>> {
    return this.runBreaker(this.voidBreaker, req);
  }

  // ───────────────────────── helpers ─────────────────────────

  private async runBreaker<TIn>(
    breaker: CircuitBreaker<[TIn], AcquirerResult>,
    request: TIn,
  ): Promise<Result<AcquirerResult, AcquirerAdapterError>> {
    // Curto-circuito explícito: se já está aberto, falha rápido sem fire.
    if (breaker.opened) {
      return err({
        code: 'CIRCUIT_OPEN',
        httpStatus: 503,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }

    try {
      const value = await breaker.fire(request);
      return ok(value);
    } catch (caught) {
      const error = caught as Error & {
        acquirerResult?: AcquirerResult;
        code?: string;
      };

      // 1) Sentinel de timeout — reidrata o AcquirerResult original.
      if (error.message === BREAKER_TIMEOUT_SENTINEL && error.acquirerResult) {
        return ok(error.acquirerResult);
      }

      // 2) Circuito aberto — defense-in-depth caso o flag mude entre o
      //    check inicial e o fire.
      const message = error.message ?? '';
      if (
        breaker.opened ||
        CIRCUIT_OPEN_MESSAGES.some((m) => message.includes(m))
      ) {
        return err({
          code: 'CIRCUIT_OPEN',
          httpStatus: 503,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        });
      }

      // 3) Timeout do PRÓPRIO opossum (configurado > client timeout —
      //    caso de degenerescência). Mapeamos para AcquirerResult TIMEOUT.
      if (error.code === 'ETIMEDOUT' || /timed? out/i.test(message)) {
        return ok(timeoutResult());
      }

      // 4) Qualquer outra exceção inesperada — devolve como
      //    SERIALIZATION_ERROR (não vaza detalhes para o caller).
      return err({ code: 'SERIALIZATION_ERROR', httpStatus: 500 });
    }
  }
}

function timeoutResult(): AcquirerResult {
  return {
    outcome: 'TIMEOUT',
    authorizationCode: null,
    acquirerReferenceNumber: null,
    declineCode: null,
    rawResponseCode: null,
  };
}

/**
 * Tenta anexar opossum-prometheus aos breakers. O pacote NÃO publica
 * declarações TS, então usamos `createRequire` e cast unknown.
 * Falhas (peer-dep prom-client ausente, módulo faltando em testes) são
 * silenciadas — métricas são opcionais para o funcionamento do adapter.
 *
 * TODO(observability): quando `prom-client` for adicionado como
 * dependência direta, integrar com o registry global e exportar via
 * GET /metrics.
 */
function tryAttachPrometheusMetrics(
  breakers: ReadonlyArray<CircuitBreaker>,
): void {
  try {
    const require_ = createRequire(import.meta.url);
    const mod: unknown = require_('opossum-prometheus');
    const Ctor = resolveOpossumPrometheusCtor(mod);
    if (Ctor === null) return;
    new Ctor({ circuits: [...breakers] });
  } catch {
    // TODO(observability): log via Pino logger quando estiver no contexto.
  }
}

type OpossumPrometheusCtor = new (opts: {
  circuits: ReadonlyArray<CircuitBreaker>;
}) => unknown;

function resolveOpossumPrometheusCtor(
  mod: unknown,
): OpossumPrometheusCtor | null {
  if (typeof mod === 'function') return mod as OpossumPrometheusCtor;
  if (mod !== null && typeof mod === 'object') {
    const named = (mod as { PrometheusMetrics?: unknown }).PrometheusMetrics;
    if (typeof named === 'function') return named as OpossumPrometheusCtor;
    const def = (mod as { default?: unknown }).default;
    if (typeof def === 'function') return def as OpossumPrometheusCtor;
  }
  return null;
}

/**
 * Singleton default do adapter. Construções em testes devem instanciar
 * `new AcquirerAdapter({ client: mockClient, disablePrometheus: true })`.
 */
export const acquirerAdapter = new AcquirerAdapter({ disablePrometheus: true });
