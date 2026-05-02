/**
 * Acquirer HTTP Client — undici, 25s timeout, W3C Trace-Context.
 *
 * Source: design.md "Acquirer Adapter" + requirements 1.1, 1.6, 8.2.
 *
 * Escopo desta task (6.1):
 *   - Cliente HTTP cru (sem circuit breaker — Task 6.2 envolverá este).
 *   - undici.request com bodyTimeout/headersTimeout = 25_000 ms
 *     (configurável via ACQUIRER_TIMEOUT_MS no env), abaixo do SLA
 *     de 30 s da req 1.1 deixando margem para a camada interna.
 *   - Métodos:
 *       authorize(req: AcquirerAuthRequest) → AcquirerResult
 *       void(req: AcquirerVoidRequest)      → AcquirerResult
 *   - Em timeout retornamos `outcome: 'TIMEOUT'` — NUNCA throw para o
 *     caller (req 1.6). Em erro de rede / 5xx do acquirer, retornamos
 *     `outcome: 'ERROR'`.
 *   - Header `Authorization: Bearer ${ACQUIRER_API_KEY}`.
 *   - W3C Trace-Context: aceita um helper `injectW3CTraceContext` por
 *     DI (Task 14.2 fornecerá). Quando ausente, cai no fallback de
 *     usar os headers do `AcquirerAuthRequest.traceContext`
 *     (`traceparent` / `tracestate`).
 *
 * TODO(research.md): O formato exato do payload HTTP para o acquirer
 * ainda não foi confirmado pela parte externa. Aqui usamos JSON com
 * fields espelhando `AcquirerAuthRequest` / `AcquirerVoidRequest` como
 * placeholder. Trocar pelo contrato real assim que o acquirer
 * publicar o spec OpenAPI deles.
 *
 * Requirements: 1.1, 1.6, 8.2.
 */

import { request, type Dispatcher } from 'undici';

import { loadEnv, type AppEnv } from '../../config/env.js';
import type {
  AcquirerAuthRequest,
  AcquirerResult,
  AcquirerVoidRequest,
  W3CTraceContext,
} from '../../shared/types.js';

/** Mapa simples header name → value para injeção. */
export type HeaderMap = Record<string, string>;

/**
 * Helper de injeção de W3C Trace-Context. Será fornecido pela
 * Task 14.2 (OpenTelemetry SDK). Quando ausente, usamos o
 * traceContext do request.
 */
export type InjectTraceContextFn = (headers: HeaderMap) => HeaderMap;

export interface AcquirerClientOptions {
  /** Override da config — útil em testes. */
  readonly env?: AppEnv;
  /** Helper DI da Task 14.2; se ausente, fallback no traceContext do request. */
  readonly injectW3CTraceContext?: InjectTraceContextFn;
}

/**
 * Resposta do acquirer no formato esperado (placeholder — vide TODO acima).
 * Mantido como interface local; a camada superior consome apenas
 * `AcquirerResult` (tipo compartilhado).
 */
interface AcquirerHttpResponseBody {
  readonly outcome?: string;
  readonly authorizationCode?: string | null;
  readonly acquirerReferenceNumber?: string | null;
  readonly declineCode?: string | null;
  readonly responseCode?: string | null;
}

const APPROVED_OUTCOME = 'APPROVED';
const DECLINED_OUTCOME = 'DECLINED';

function isUndiciTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // undici expõe códigos `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`
  // e `UND_ERR_CONNECT_TIMEOUT`. Também aceitamos `name === 'TimeoutError'`.
  const code = (error as Error & { code?: string }).code ?? '';
  if (code.includes('TIMEOUT')) return true;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  if (/timeout/i.test(error.message)) return true;
  return false;
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

function errorResult(rawResponseCode: string | null = null): AcquirerResult {
  return {
    outcome: 'ERROR',
    authorizationCode: null,
    acquirerReferenceNumber: null,
    declineCode: null,
    rawResponseCode,
  };
}

function fallbackTraceHeaders(traceContext: W3CTraceContext): HeaderMap {
  const headers: HeaderMap = {
    traceparent: traceContext.traceparent,
  };
  if (traceContext.tracestate !== undefined) {
    headers['tracestate'] = traceContext.tracestate;
  }
  return headers;
}

export class AcquirerClient {
  private readonly env: AppEnv;
  private readonly inject: InjectTraceContextFn | undefined;

  public constructor(options: AcquirerClientOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.inject = options.injectW3CTraceContext;
  }

  /**
   * Autoriza uma transação.
   * Em timeout retorna `outcome: 'TIMEOUT'`; em erro de rede / 5xx
   * retorna `outcome: 'ERROR'`. Nunca throw.
   */
  public async authorize(req: AcquirerAuthRequest): Promise<AcquirerResult> {
    // TODO(research.md): formato HTTP real do acquirer.
    const body = JSON.stringify({
      merchantId: req.merchantId,
      terminalId: req.terminalId,
      amount: req.amount,
      currency: req.currency,
      paymentMethodType: req.paymentMethodType,
      maskedPan: req.maskedPan,
    });
    return this.send('/authorizations', body, req.traceContext);
  }

  /**
   * Cancela (void) uma transação previamente aprovada.
   */
  public async void(req: AcquirerVoidRequest): Promise<AcquirerResult> {
    // TODO(research.md): formato HTTP real do acquirer.
    const body = JSON.stringify({
      authorizationCode: req.authorizationCode,
      originalAmount: req.originalAmount,
    });
    return this.send('/voids', body, req.traceContext);
  }

  // ────────────────────────── internals ──────────────────────────

  private buildHeaders(traceContext: W3CTraceContext): HeaderMap {
    const baseHeaders: HeaderMap = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${this.env.ACQUIRER_API_KEY}`,
    };
    if (this.inject) {
      try {
        return { ...baseHeaders, ...this.inject({ ...baseHeaders }) };
      } catch {
        // Falha do helper de DI não pode quebrar a chamada — fallback.
        return { ...baseHeaders, ...fallbackTraceHeaders(traceContext) };
      }
    }
    return { ...baseHeaders, ...fallbackTraceHeaders(traceContext) };
  }

  private buildUrl(path: string): string {
    const base = this.env.ACQUIRER_BASE_URL.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private async send(
    path: string,
    body: string,
    traceContext: W3CTraceContext,
  ): Promise<AcquirerResult> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(traceContext);
    const timeoutMs = this.env.ACQUIRER_TIMEOUT_MS;

    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: 'POST',
        headers,
        body,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      if (isUndiciTimeout(error)) {
        return timeoutResult();
      }
      return errorResult(null);
    }

    // 5xx → ERROR. Outros 4xx (que não 200/201/202) também → ERROR
    // genérico, salvo se o body tiver outcome explícito.
    let raw: AcquirerHttpResponseBody;
    try {
      raw = (await response.body.json()) as AcquirerHttpResponseBody;
    } catch {
      // body inválido / não-JSON → ERROR.
      return errorResult(String(response.statusCode));
    }

    if (response.statusCode >= 500) {
      return errorResult(String(response.statusCode));
    }

    return this.parseResponse(raw, response.statusCode);
  }

  private parseResponse(
    raw: AcquirerHttpResponseBody,
    statusCode: number,
  ): AcquirerResult {
    const outcome = (raw.outcome ?? '').toUpperCase();

    if (outcome === APPROVED_OUTCOME) {
      return {
        outcome: 'APPROVED',
        authorizationCode: raw.authorizationCode ?? null,
        acquirerReferenceNumber: raw.acquirerReferenceNumber ?? null,
        declineCode: null,
        rawResponseCode: raw.responseCode ?? String(statusCode),
      };
    }

    if (outcome === DECLINED_OUTCOME) {
      return {
        outcome: 'DECLINED',
        authorizationCode: null,
        acquirerReferenceNumber: raw.acquirerReferenceNumber ?? null,
        declineCode: raw.declineCode ?? null,
        rawResponseCode: raw.responseCode ?? String(statusCode),
      };
    }

    // Outcome desconhecido → erro lógico do acquirer.
    return errorResult(raw.responseCode ?? String(statusCode));
  }
}

/**
 * Instância default. A Task 6.2 (circuit breaker) deve preferir
 * construir explicitamente a sua própria instância injetando o
 * helper W3C real, mas mantemos um singleton para conveniência.
 */
export const acquirerClient = new AcquirerClient();
