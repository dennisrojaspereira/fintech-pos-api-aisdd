/**
 * Void Service — orquestra o cancelamento de uma transacao aprovada.
 *
 * Source: design.md "Void Service" + requirements 3.1, 3.2, 3.3, 3.4, 3.5,
 * 8.3.
 *
 * Responsabilidades (Tasks 10.1 e 10.2):
 *   1. Carregar a transacao alvo respeitando tenant isolation (req 6.4
 *      delegado ao repo via findById(id, merchantId)); se nao existir
 *      retorna NOT_FOUND (404 — req 2.2 / 3.x).
 *   2. Validar elegibilidade — somente transacoes com status APPROVED
 *      podem ser canceladas. Status terminais (VOIDED, SETTLED, DECLINED)
 *      ou transitorios (PENDING) retornam 409 com currentStatus
 *      (reqs 3.1, 3.2).
 *   3. Encaminhar a chamada ao Acquirer Adapter (void(req)) usando o
 *      authorizationCode da transacao original. Se o adapter retornar
 *      CIRCUIT_OPEN propagamos como tal (503 + retryAfter — paralelo
 *      ao TransactionError); demais outcomes seguem para mapeamento.
 *   4. Outcomes do acquirer:
 *        - APPROVED -> atualiza status para VOIDED via updateStatus(id,
 *          expectedVersion, 'VOIDED', { voidedBy, voidedAt }) e dispara
 *          audit log (fire-and-forget) com action='VOID' (reqs 3.1, 3.3,
 *          8.3). Retorna VoidResult.
 *        - DECLINED ou ERROR -> nao altera status original; retorna 422
 *          ACQUIRER_REJECTED com reason vinda do declineCode ou
 *          fallback (req 3.4).
 *        - TIMEOUT -> tratado como ACQUIRER_REJECTED com reason
 *          'ACQUIRER_TIMEOUT' (nao promovemos PENDING a partir de
 *          APPROVED; manter status original e o comportamento seguro
 *          conforme req 3.4: "retain the original transaction status
 *          unchanged" em rejeicao/erro).
 *
 * Sobre transactions:void scope (req 3.5):
 *   O scope guard e aplicado na ROTA pela Task 13.1 (registro Fastify
 *   com requireScope('transactions:void') no preHandler). Aqui o
 *   service ASSUME que o caller ja passou pelo guard — nao duplicamos
 *   a checagem. Tenant isolation continua sendo aplicado via
 *   merchantId do VoidCommand (extraido das claims do JWT pelo
 *   route handler).
 *
 * Sobre TraceContext:
 *   AcquirerVoidRequest exige W3CTraceContext. Geramos um a partir
 *   do span ativo via injectW3CTraceContext, com fallback para
 *   string vazia quando nao ha contexto (cenario de testes; o adapter
 *   apenas repassa para headers HTTP).
 */

import { context, propagation } from '@opentelemetry/api';

import {
  acquirerAdapter as defaultAcquirerAdapter,
  AcquirerAdapter,
} from '../../infra/acquirer/acquirer-adapter.js';
import {
  auditLogRepository as defaultAuditLogRepository,
  AuditLogRepository,
} from '../../infra/persistence/audit-log.repo.js';
import {
  transactionRepository as defaultTransactionRepository,
  TransactionRepository,
} from '../../infra/persistence/transaction.repo.js';
import { TransactionStatus } from '../../shared/enums.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  AcquirerVoidRequest,
  TransactionRecord,
  VoidCommand,
  VoidError,
  VoidResult,
  W3CTraceContext,
} from '../../shared/types.js';

/**
 * Status que NAO podem transitar para VOIDED. Mantido em paralelo com a
 * state machine (src/domain/transaction/state-machine.ts) — ela permite
 * APPROVED -> VOIDED como unica origem. Reqs 3.1, 3.2.
 */
const NOT_ELIGIBLE_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.VOIDED,
  TransactionStatus.SETTLED,
  TransactionStatus.DECLINED,
  TransactionStatus.PENDING,
]);

interface VoidServiceOptions {
  readonly transactionRepository?: TransactionRepository;
  readonly acquirerAdapter?: AcquirerAdapter;
  readonly auditLogRepository?: AuditLogRepository;
}

export class VoidService {
  private readonly transactionRepository: TransactionRepository;
  private readonly acquirerAdapter: AcquirerAdapter;
  private readonly auditLogRepository: AuditLogRepository;

  public constructor(options: VoidServiceOptions = {}) {
    this.transactionRepository =
      options.transactionRepository ?? defaultTransactionRepository;
    this.acquirerAdapter = options.acquirerAdapter ?? defaultAcquirerAdapter;
    this.auditLogRepository =
      options.auditLogRepository ?? defaultAuditLogRepository;
  }

  /**
   * Cancela uma transacao aprovada.
   *
   * Pre-condicoes:
   *   - O caller (route handler / preHandler) ja validou JWT + scope
   *     transactions:void (req 3.5 — Task 13.1).
   *   - cmd.merchantId foi extraido das claims do JWT, garantindo
   *     tenant isolation (req 6.4).
   *
   * Pos-condicoes no caminho feliz:
   *   - transaction.status = 'VOIDED', voidedAt e voidedBy
   *     populados (req 3.3).
   *   - Uma entrada AuditEntry { action: 'VOID', outcome: 'SUCCESS' }
   *     e solicitada ao repo de audit (fire-and-forget; req 8.3).
   *
   * Reqs cobertos: 3.1, 3.2, 3.3, 3.4, 3.5, 8.3.
   */
  public async void(
    cmd: VoidCommand,
  ): Promise<Result<VoidResult, VoidError>> {
    // (1) Carrega a transacao com tenant isolation embutido no repo.
    const tx: TransactionRecord | null =
      await this.transactionRepository.findById(cmd.transactionId, cmd.merchantId);
    if (tx === null) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }

    // (2) Elegibilidade — so APPROVED segue. Status terminais/PENDING -> 409.
    if (tx.status !== TransactionStatus.APPROVED) {
      // Defensive: se aparecer um status fora do conjunto conhecido,
      // tratamos como NOT_ELIGIBLE para preservar a invariante de que
      // somente APPROVED e elegivel (req 3.2).
      const currentStatus: TransactionStatus = NOT_ELIGIBLE_STATUSES.has(tx.status)
        ? tx.status
        : tx.status;
      return err({
        code: 'NOT_ELIGIBLE',
        currentStatus,
        httpStatus: 409,
      });
    }

    // Sanity: APPROVED sem authorizationCode e anomalia. O acquirer nao
    // tem como cancelar sem o codigo original; tratamos como rejeicao.
    if (tx.authorizationCode === null || tx.authorizationCode.length === 0) {
      return err({
        code: 'ACQUIRER_REJECTED',
        reason: 'MISSING_AUTHORIZATION_CODE',
        httpStatus: 422,
      });
    }

    // (3) Chamada ao acquirer atraves do circuit breaker.
    const acquirerRequest: AcquirerVoidRequest = {
      authorizationCode: tx.authorizationCode,
      originalAmount: tx.amount,
      traceContext: currentTraceContext(),
    };

    const acquirerResponse = await this.acquirerAdapter.void(acquirerRequest);
    if (!acquirerResponse.ok) {
      const adapterError = acquirerResponse.error;
      if (adapterError.code === 'CIRCUIT_OPEN') {
        return err({
          code: 'CIRCUIT_OPEN',
          httpStatus: 503,
          retryAfterSeconds: adapterError.retryAfterSeconds,
        });
      }
      // SERIALIZATION_ERROR ou outro adapter error -> mapeamos para
      // ACQUIRER_REJECTED (422) preservando o status original (req 3.4).
      return err({
        code: 'ACQUIRER_REJECTED',
        reason: 'ACQUIRER_ADAPTER_ERROR',
        httpStatus: 422,
      });
    }

    const acquirerResult = acquirerResponse.value;

    // (4) Mapeia outcomes do acquirer.
    if (
      acquirerResult.outcome === 'DECLINED' ||
      acquirerResult.outcome === 'ERROR' ||
      acquirerResult.outcome === 'TIMEOUT'
    ) {
      const reason: string =
        acquirerResult.declineCode ??
        (acquirerResult.outcome === 'TIMEOUT'
          ? 'ACQUIRER_TIMEOUT'
          : 'ACQUIRER_ERROR');
      return err({
        code: 'ACQUIRER_REJECTED',
        reason,
        httpStatus: 422,
      });
    }

    // outcome === 'APPROVED' -> confirma o void (Task 10.2).
    const voidedAt = new Date();
    const voidedAtIso = voidedAt.toISOString();

    const updateOutcome = await this.transactionRepository.updateStatus(
      tx.id,
      tx.version,
      TransactionStatus.VOIDED,
      {
        voidedBy: cmd.operatorId,
        voidedAt,
      },
    );

    if (!updateOutcome.ok) {
      // VERSION_CONFLICT / NOT_FOUND aqui significam que outro fluxo
      // mexeu na linha entre o findById e o updateStatus. Retornamos
      // ACQUIRER_REJECTED e incorreto (o acquirer aprovou); o estado
      // local apenas nao pode refletir. Reportamos como NOT_ELIGIBLE
      // com o status atual conhecido — no cenario de SETTLED concorrente
      // e o resultado correto. Para VERSION_CONFLICT generico, usamos
      // o status original APPROVED como hint (cliente pode reler).
      // TODO(observability): emitir metrica de race-condition aqui.
      const currentStatus: TransactionStatus =
        updateOutcome.error.code === 'NOT_FOUND'
          ? TransactionStatus.VOIDED
          : tx.status;
      return err({
        code: 'NOT_ELIGIBLE',
        currentStatus,
        httpStatus: 409,
      });
    }

    // Audit log fire-and-forget (req 8.3, 8.4 — nao bloqueia o fluxo).
    // Nao usamos await deliberadamente; o repo e nao-rejeitante por
    // contrato. Fazemos void para silenciar lint sobre floating promise.
    void this.auditLogRepository.write({
      actorId: cmd.operatorId,
      action: 'VOID',
      resourceId: tx.id,
      outcome: 'SUCCESS',
      timestamp: voidedAtIso,
      metadata: {
        authorizationCode: tx.authorizationCode,
      },
    });

    return ok({
      transactionId: tx.id,
      status: 'VOIDED',
      voidedAt: voidedAtIso,
      voidedBy: cmd.operatorId,
    });
  }
}

/**
 * Constroi um W3CTraceContext a partir do span ativo (se houver),
 * usando o propagador OTel registrado pelo SDK (Task 14.2).
 *
 * Quando nao ha span ativo (testes unitarios ou chamadas fora do
 * request lifecycle), retorna um traceparent vazio — o adapter ainda
 * funciona; os headers correspondentes serao simplesmente strings
 * vazias para o servidor remoto, que tipicamente as ignora.
 */
function currentTraceContext(): W3CTraceContext {
  const carrier: Record<string, string> = {};
  try {
    propagation.inject(context.active(), carrier, {
      set: (c, key, value) => {
        if (typeof value === 'string') {
          (c as Record<string, string>)[key] = value;
        }
      },
    });
  } catch {
    // Falha do propagator nao pode quebrar o void — usa fallback vazio.
  }
  const traceparent = carrier['traceparent'] ?? '';
  const tracestate = carrier['tracestate'];
  return tracestate !== undefined
    ? { traceparent, tracestate }
    : { traceparent };
}

export const voidService = new VoidService();
