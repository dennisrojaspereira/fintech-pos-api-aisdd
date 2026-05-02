/**
 * Transaction Service — orquestracao do ciclo de autorizacao de transacoes.
 *
 * Source: design.md "Transaction Service" + requirements 1.1, 1.2, 1.3,
 * 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5.
 *
 * Reune quatro metodos publicos que cobrem as sub-tasks 9.1-9.4:
 *
 *   - validateAuthorizeCommand (9.1) — validacao dos campos obrigatorios
 *     do comando antes de qualquer chamada externa. Retorna 422 com a
 *     lista agregada de campos invalidos. Reqs 1.2 / 1.3.
 *
 *   - assertTerminalOwnership (9.1) — verifica via Prisma que o
 *     terminalId informado pertence ao merchantId extraido do JWT.
 *     Req 6.4 (tenant isolation aplicado no recurso terminal).
 *
 *   - authorize (9.2) — pipeline completo: valida -> ownership ->
 *     AcquirerAdapter.authorize -> persiste (transaction + audit) ->
 *     devolve TransactionResult. Persistencia da transacao e atomica
 *     com prisma.$transaction (req 1.4); o audit log roda fora do tx
 *     para preservar a regra "audit log failure must NOT fail business
 *     operation" (req 8.4). Reqs 1.1, 1.4, 1.5, 1.6.
 *
 *   - getById (9.3) — busca por id com tenant isolation; quando o
 *     status e PENDING, atualiza lastAcquirerCheckAt e devolve o
 *     registro. A resolucao real (re-poll do acquirer) esta marcada
 *     como TODO. Reqs 2.1, 2.2, 2.3, 2.4.
 *
 *   - list (9.4) — delega para transactionRepository.list, garantindo
 *     que merchantId esteja presente. Req 2.5.
 *
 * Decisao de mapeamento HTTP: as quatro APIs retornam Result<T,
 * TransactionError>. Para o caso de sucesso, o caller (Task 13.x)
 * inspeciona TransactionResult.status para definir o HTTP code:
 *   - APPROVED   -> 201
 *   - DECLINED   -> 200
 *   - PENDING    -> 202 (cobre TIMEOUT e ERROR do acquirer; req 1.6)
 * Manter o servico retornando ok(...) mesmo para PENDING simplifica
 * o fluxo de cache de idempotencia (req 7.x): o response 202 e
 * cacheado como qualquer outro sucesso. CIRCUIT_OPEN e o unico
 * cenario em que devolvemos err, pois ali nem chegamos a persistir.
 */

import { PrismaClient } from '@prisma/client';

import { PaymentMethodType, TransactionStatus } from '../../shared/enums.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  AcquirerAuthRequest,
  AcquirerResult,
  AuthorizeCommand,
  FieldError,
  PaginatedList,
  TransactionError,
  TransactionListFilters,
  TransactionRecord,
  TransactionResult,
  W3CTraceContext,
} from '../../shared/types.js';
import {
  AcquirerAdapter,
  acquirerAdapter as defaultAcquirer,
} from '../../infra/acquirer/acquirer-adapter.js';
import {
  AuditLogRepository,
  auditLogRepository as defaultAudit,
} from '../../infra/persistence/audit-log.repo.js';
import { prisma as defaultPrisma } from '../../infra/persistence/prisma.js';
import {
  TransactionRepository,
  transactionRepository as defaultRepo,
} from '../../infra/persistence/transaction.repo.js';
import { injectW3CTraceContext } from '../../infra/observability/tracing.js';
import { MaskedPan } from '../value-objects/masked-pan.js';

/** Padrao ISO 4217 — exatamente 3 letras maiusculas. */
const ISO_4217_PATTERN = /^[A-Z]{3}$/;

/**
 * Tipos auxiliares para extrair o "transactional client" do Prisma sem
 * depender do pacote `Prisma` (que so e gerado por `prisma generate`).
 * Em runtime o callback de prisma.$transaction recebe um cliente com
 * a mesma forma do PrismaClient — usamos um alias estrutural.
 */
type PrismaTxClient = PrismaClient;

interface TransactionServiceDeps {
  readonly repo?: TransactionRepository;
  readonly audit?: AuditLogRepository;
  readonly acquirer?: AcquirerAdapter;
  readonly db?: PrismaClient;
}

/**
 * Erros possiveis do `assertTerminalOwnership` (uso interno). O caller
 * mapeia para TransactionError.VALIDATION_ERROR (httpStatus 422) com
 * field='terminalId', conforme decisao da Task 9.1.
 */
type OwnershipError =
  | { readonly code: 'TERMINAL_NOT_FOUND' }
  | { readonly code: 'TERMINAL_FOREIGN_MERCHANT' };

export class TransactionService {
  private readonly repo: TransactionRepository;
  private readonly audit: AuditLogRepository;
  private readonly acquirer: AcquirerAdapter;
  private readonly db: PrismaClient;

  public constructor(deps: TransactionServiceDeps = {}) {
    this.repo = deps.repo ?? defaultRepo;
    this.audit = deps.audit ?? defaultAudit;
    this.acquirer = deps.acquirer ?? defaultAcquirer;
    this.db = deps.db ?? defaultPrisma;
  }

  // ─────────────────────────────────────────────────────────────────
  // 9.1 — Validacao + ownership terminal
  // ─────────────────────────────────────────────────────────────────

  /**
   * Valida os campos do AuthorizeCommand e retorna 422 agregando todos
   * os erros encontrados (req 1.3 — "identifying each invalid field").
   *
   * Cobertura:
   *   - amount: inteiro positivo (req 1.8 / 1.2)
   *   - currency: ISO 4217 (3 letras maiusculas)
   *   - paymentMethod.type: valor valido do enum PaymentMethodType
   *   - paymentMethod.maskedPan: passa por MaskedPan.create (rejeita
   *     PAN completo — defesa em profundidade conforme Security
   *     Considerations)
   *   - terminalId / merchantId / idempotencyKey: strings nao-vazias
   *
   * Reqs: 1.2, 1.3.
   */
  public validateAuthorizeCommand(
    cmd: AuthorizeCommand,
  ): Result<void, TransactionError> {
    const fields: FieldError[] = [];

    if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) {
      fields.push({
        field: 'amount',
        message: 'amount must be a positive integer in the smallest currency unit',
      });
    }

    if (typeof cmd.currency !== 'string' || !ISO_4217_PATTERN.test(cmd.currency)) {
      fields.push({
        field: 'currency',
        message: 'currency must be a 3-letter ISO 4217 code (uppercase)',
      });
    }

    if (!isNonEmptyString(cmd.terminalId)) {
      fields.push({ field: 'terminalId', message: 'terminalId is required' });
    }

    if (!isNonEmptyString(cmd.merchantId)) {
      fields.push({ field: 'merchantId', message: 'merchantId is required' });
    }

    if (!isNonEmptyString(cmd.idempotencyKey)) {
      fields.push({
        field: 'idempotencyKey',
        message: 'idempotencyKey is required',
      });
    }

    if (!cmd.paymentMethod || typeof cmd.paymentMethod !== 'object') {
      fields.push({
        field: 'paymentMethod',
        message: 'paymentMethod is required',
      });
    } else {
      const pm = cmd.paymentMethod;
      if (!isValidPaymentMethodType(pm.type)) {
        fields.push({
          field: 'paymentMethod.type',
          message: 'paymentMethod.type must be CREDIT_CARD, DEBIT_CARD or CONTACTLESS_NFC',
        });
      }
      const pan = MaskedPan.create(pm.maskedPan);
      if (pan.ok === false) {
        const code = pan.error.code;
        fields.push({
          field: 'paymentMethod.maskedPan',
          message:
            code === 'FULL_PAN_FORBIDDEN'
              ? 'paymentMethod.maskedPan must not contain a full PAN'
              : 'paymentMethod.maskedPan must match the masked format ****1234',
        });
      }
    }

    if (fields.length > 0) {
      return err({ code: 'VALIDATION_ERROR', fields, httpStatus: 422 });
    }
    return ok(undefined);
  }

  /**
   * Verifica que o terminalId pertence ao merchantId fornecido.
   * Cobre req 1.2 (terminalId e parte da validacao pre-acquirer) e
   * req 6.4 (tenant isolation por merchant). Em qualquer falha
   * (terminal inexistente OU pertencente a outro merchant) devolvemos
   * VALIDATION_ERROR(field='terminalId', http 422) — a falha vista
   * pelo caller e uma so, sem vazar a existencia de terminais alheios.
   *
   * Reqs: 1.2, 6.4.
   */
  public async assertTerminalOwnership(
    merchantId: string,
    terminalId: string,
  ): Promise<Result<void, TransactionError>> {
    const ownership = await this.lookupTerminal(merchantId, terminalId);
    if (ownership.ok === true) {
      return ok(undefined);
    }
    return err({
      code: 'VALIDATION_ERROR',
      fields: [
        {
          field: 'terminalId',
          message: 'terminal does not belong to the authenticated merchant',
        },
      ],
      httpStatus: 422,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 9.2 — Orquestracao com acquirer (atomic persist)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Pipeline de autorizacao — executa validacao, ownership, chama o
   * acquirer e persiste a transacao.
   *
   * Mapeamento de outcomes do AcquirerAdapter:
   *   APPROVED -> status APPROVED, sucesso (HTTP 201 a cargo do caller)
   *   DECLINED -> status DECLINED, sucesso (HTTP 200)
   *   TIMEOUT  -> status PENDING,  sucesso (HTTP 202; req 1.6)
   *   ERROR    -> status PENDING,  sucesso (HTTP 202) — decisao
   *               alinhada ao design.md "Implementation Notes" do
   *               Transaction Service: nunca expor mensagem crua do
   *               acquirer; tratar erro generico como "indeterminado",
   *               persistindo PENDING para que o terminal possa
   *               consultar mais tarde.
   *   Result.err CIRCUIT_OPEN -> propaga como TransactionError
   *               CIRCUIT_OPEN (HTTP 503 + Retry-After).
   *   Result.err SERIALIZATION_ERROR -> INTERNAL_ERROR (HTTP 500).
   *
   * Persistencia atomica: a criacao da Transaction roda dentro de
   * prisma.$transaction. O audit log e gravado APOS o commit — req 8.4
   * manda que falha de auditoria nao derrube a operacao de negocio,
   * e o repo de audit ja e fire-and-forget (nao rejeita ao caller).
   *
   * Reqs: 1.1, 1.4, 1.5, 1.6.
   */
  public async authorize(
    cmd: AuthorizeCommand,
  ): Promise<Result<TransactionResult, TransactionError>> {
    const validation = this.validateAuthorizeCommand(cmd);
    if (validation.ok === false) return err(validation.error);

    const ownership = await this.assertTerminalOwnership(
      cmd.merchantId,
      cmd.terminalId,
    );
    if (ownership.ok === false) return err(ownership.error);

    const acqRequest = this.buildAcquirerRequest(cmd);
    const acqResult = await this.acquirer.authorize(acqRequest);

    if (acqResult.ok === false) {
      return mapAcquirerAdapterError(acqResult.error);
    }

    const acquirerResult = acqResult.value;
    const status = mapOutcomeToStatus(acquirerResult.outcome);

    let saved: TransactionRecord;
    try {
      saved = await this.db.$transaction(
        async (tx: PrismaTxClient): Promise<TransactionRecord> => {
          const txRepo = new TransactionRepository(tx);
          return txRepo.create({
            merchantId: cmd.merchantId,
            terminalId: cmd.terminalId,
            amount: cmd.amount,
            currency: cmd.currency,
            paymentMethodType: cmd.paymentMethod.type,
            maskedPan: cmd.paymentMethod.maskedPan,
            status,
            authorizationCode: acquirerResult.authorizationCode,
            acquirerReferenceNumber: acquirerResult.acquirerReferenceNumber,
            acquirerDeclineCode: acquirerResult.declineCode,
          });
        },
      );
    } catch {
      // Falha inesperada de persistencia — nao vazamos detalhes.
      return err({ code: 'INTERNAL_ERROR', httpStatus: 500 });
    }

    // Audit log fire-and-forget (NAO bloqueia a resposta, e o repo ja
    // engole excecoes internamente — req 8.4).
    void this.audit.write({
      actorId: cmd.merchantId,
      action: 'AUTHORIZE',
      resourceId: saved.id,
      outcome: status === TransactionStatus.APPROVED ? 'SUCCESS' : 'FAILURE',
      metadata: {
        terminalId: cmd.terminalId,
        amount: cmd.amount,
        currency: cmd.currency,
        idempotencyKey: cmd.idempotencyKey,
        acquirerOutcome: acquirerResult.outcome,
      },
    });

    return ok(toTransactionResult(saved));
  }

  // ─────────────────────────────────────────────────────────────────
  // 9.3 — getById + resolucao PENDING
  // ─────────────────────────────────────────────────────────────────

  /**
   * Busca uma transacao por id com tenant isolation. Para registros em
   * status PENDING, atualiza lastAcquirerCheckAt e devolve a versao
   * fresca. A resolucao real (re-poll do acquirer) e tratada por um
   * worker fora deste service — aqui apenas registramos o timestamp
   * do ultimo check (req 2.3) e devolvemos o status corrente (req 2.4
   * garante que a proxima chamada reflete o final status assim que o
   * worker resolver).
   *
   * Reqs: 2.1, 2.2, 2.3, 2.4.
   */
  public async getById(
    transactionId: string,
    merchantId: string,
  ): Promise<Result<TransactionRecord, TransactionError>> {
    const record = await this.repo.findById(transactionId, merchantId);
    if (!record) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }

    if (record.status !== TransactionStatus.PENDING) {
      return ok(record);
    }

    // TODO(9.3): orquestrar um re-poll real do acquirer via endpoint
    // dedicado de status. Por ora, apenas atualizamos lastAcquirerCheckAt
    // para que o terminal consiga rastrear o progresso de resolucao
    // (req 2.3). O status atualizado real virá de um worker dedicado
    // adicionado em uma task posterior.
    const updated = await this.repo.updateStatus(
      record.id,
      record.version,
      TransactionStatus.PENDING,
      { lastAcquirerCheckAt: new Date() },
    );

    if (updated.ok === true) {
      return ok(updated.value);
    }
    // Conflito de versao ou registro removido entre findById e update
    // — devolvemos o snapshot original; cliente pode re-tentar.
    return ok(record);
  }

  // ─────────────────────────────────────────────────────────────────
  // 9.4 — list paginado
  // ─────────────────────────────────────────────────────────────────

  /**
   * Lista paginada de transacoes com filtros opcionais. O caller (rota)
   * e responsavel por injetar o merchantId extraido do JWT — aqui
   * apenas validamos a presenca e delegamos para o repositorio.
   * Reqs: 2.5 + 6.4.
   */
  public async list(
    filters: TransactionListFilters,
  ): Promise<Result<PaginatedList<TransactionRecord>, TransactionError>> {
    if (!isNonEmptyString(filters.merchantId)) {
      return err({
        code: 'VALIDATION_ERROR',
        fields: [
          { field: 'merchantId', message: 'merchantId is required' },
        ],
        httpStatus: 422,
      });
    }
    const list = await this.repo.list(filters);
    return ok(list);
  }

  // ─────────────────────────────────────────────────────────────────
  // helpers privados
  // ─────────────────────────────────────────────────────────────────

  private async lookupTerminal(
    merchantId: string,
    terminalId: string,
  ): Promise<Result<void, OwnershipError>> {
    // Tipamos o retorno do Prisma localmente — o pacote @prisma/client
    // so tem tipos completos apos prisma generate, e este projeto nao
    // roda generate em CI.
    const terminal = (await this.db.terminal.findUnique({
      where: { id: terminalId },
    })) as { id: string; merchantId: string } | null;

    if (!terminal) {
      return err({ code: 'TERMINAL_NOT_FOUND' });
    }
    if (terminal.merchantId !== merchantId) {
      return err({ code: 'TERMINAL_FOREIGN_MERCHANT' });
    }
    return ok(undefined);
  }

  private buildAcquirerRequest(cmd: AuthorizeCommand): AcquirerAuthRequest {
    const traceContext = buildTraceContext();
    return {
      merchantId: cmd.merchantId,
      terminalId: cmd.terminalId,
      amount: cmd.amount,
      currency: cmd.currency,
      paymentMethodType: cmd.paymentMethod.type,
      maskedPan: cmd.paymentMethod.maskedPan,
      traceContext,
    };
  }
}

// ───────────────────────── helpers de modulo ─────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidPaymentMethodType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    value === PaymentMethodType.CREDIT_CARD ||
    value === PaymentMethodType.DEBIT_CARD ||
    value === PaymentMethodType.CONTACTLESS_NFC
  );
}

function mapOutcomeToStatus(
  outcome: AcquirerResult['outcome'],
): TransactionStatus {
  switch (outcome) {
    case 'APPROVED':
      return TransactionStatus.APPROVED;
    case 'DECLINED':
      return TransactionStatus.DECLINED;
    case 'TIMEOUT':
    case 'ERROR':
      // Decisao (design.md): em ERROR nao vazamos a mensagem crua e
      // tratamos como indeterminado — PENDING + 202, igual TIMEOUT.
      return TransactionStatus.PENDING;
    default:
      return TransactionStatus.PENDING;
  }
}

function mapAcquirerAdapterError(
  error:
    | { code: 'CIRCUIT_OPEN'; httpStatus: 503; retryAfterSeconds: number }
    | { code: 'SERIALIZATION_ERROR'; httpStatus: 500 },
): Result<never, TransactionError> {
  if (error.code === 'CIRCUIT_OPEN') {
    return err({
      code: 'CIRCUIT_OPEN',
      httpStatus: 503,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  return err({ code: 'INTERNAL_ERROR', httpStatus: 500 });
}

function toTransactionResult(record: TransactionRecord): TransactionResult {
  return {
    transactionId: record.id,
    status: record.status,
    authorizationCode: record.authorizationCode,
    acquirerDeclineCode: record.acquirerDeclineCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildTraceContext(): W3CTraceContext {
  // injectW3CTraceContext popula traceparent (e opcionalmente
  // tracestate) a partir do span ativo. Se nao houver span no contexto,
  // o objeto fica vazio e tratamos com defaults — preenchemos string
  // vazia como sentinel (req 8.2 — tracing presente quando ha span).
  const headers = injectW3CTraceContext({});
  const traceparent = headers['traceparent'] ?? '';
  const tracestate = headers['tracestate'];
  return tracestate !== undefined
    ? { traceparent, tracestate }
    : { traceparent };
}

/**
 * Singleton default. Em testes, instancie via
 * `new TransactionService({ repo, audit, acquirer, db })` com mocks.
 */
export const transactionService = new TransactionService();
