/**
 * Reconciliation Service — gera dados de conciliação inline ou
 * dispara um job assíncrono para grandes resultsets.
 *
 * Source:
 *   - design.md "Reconciliation Service" (Components and Interfaces)
 *   - design.md "Batch / Job Contract"
 *   - requirements.md 5.1, 5.2, 5.3, 5.4, 5.5
 *   - tasks.md 12.1 + 12.2
 *
 * Notas:
 *   - O scope guard `reconciliation:read` (req 5.2) é aplicado pela
 *     camada HTTP (task 13.1). Aqui o serviço não checa scopes.
 *   - Tipos compartilhados vêm de `src/shared/types.ts` — fonte única,
 *     não redefinir.
 *   - Datas em {@link ReconciliationQuery} são strings ISO 8601 (date).
 *     Calculamos a diferença em dias com `Date` apenas para validação
 *     (req 5.3).
 */

import {
  ReconciliationQueue,
  hashQuery,
} from '../../infra/queue/reconciliation-queue.js';
import {
  TransactionRepository,
  transactionRepository as defaultRepo,
} from '../../infra/persistence/transaction.repo.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  ReconciliationError,
  ReconciliationJob,
  ReconciliationQuery,
  ReconciliationRecord,
  ReconciliationSummary,
} from '../../shared/types.js';

/** Limite máximo de janela em dias (req 5.3). */
const MAX_DATE_RANGE_DAYS = 31;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calcula a diferença em dias inteiros entre `endDate` e `startDate`.
 * Trata strings ISO 8601 — `YYYY-MM-DD` ou timestamps completos. Usa
 * `Math.floor` para que ranges de exatamente 31 dias sejam aceitos
 * (req 5.3 menciona "exceeding 31 days" → > 31 falha; = 31 passa).
 */
function diffInDays(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  return Math.floor((end - start) / MS_PER_DAY);
}

/**
 * Valida o intervalo da query: `start <= end` e diferença ≤ 31 dias.
 * Retorna `null` quando válido; `ReconciliationError` caso contrário.
 *
 * Quando `start > end`, devolvemos o mesmo erro `DATE_RANGE_EXCEEDED`:
 * o cliente recebe HTTP 400 com a mesma mensagem orientadora (req 5.3).
 */
function validateDateRange(
  query: ReconciliationQuery,
): ReconciliationError | null {
  const days = diffInDays(query.startDate, query.endDate);
  if (days < 0 || days > MAX_DATE_RANGE_DAYS) {
    return { code: 'DATE_RANGE_EXCEEDED', maxDays: 31, httpStatus: 400 };
  }
  return null;
}

/**
 * Soma os amounts (cents) agrupando por `paymentMethodType` (req 5.1).
 * Mantém zero quando um método não aparece — o consumidor adiciona
 * chaves vazias ao gosto.
 */
function totalsByMethod(
  records: readonly ReconciliationRecord[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of records) {
    const key = record.paymentMethodType;
    totals[key] = (totals[key] ?? 0) + record.amount;
  }
  return totals;
}

export class ReconciliationService {
  private readonly transactionRepository: TransactionRepository;
  private readonly queue: ReconciliationQueue | null;

  /**
   * @param deps.transactionRepository — repositório de transações.
   * @param deps.queue — instância da {@link ReconciliationQueue}. Pode
   *   ser omitida em ambientes onde apenas o endpoint síncrono é usado;
   *   nesse caso, `createExportJob`/`getJobStatus` retornam erro
   *   explícito ao serem chamados (raro: o bootstrap normalmente
   *   provê o queue).
   */
  public constructor(
    deps: {
      readonly transactionRepository?: TransactionRepository;
      readonly queue?: ReconciliationQueue;
    } = {},
  ) {
    this.transactionRepository = deps.transactionRepository ?? defaultRepo;
    this.queue = deps.queue ?? null;
  }

  /**
   * Reconciliation síncrona (req 5.1, 5.2, 5.3, 5.4).
   *
   * Fluxo:
   *   1. Valida que `startDate <= endDate` e diferença em dias ≤ 31
   *      (req 5.3). Se exceder, devolve `DATE_RANGE_EXCEEDED` (HTTP 400).
   *   2. Chama `transactionRepository.listForReconciliation(query)` —
   *      filtra APPROVED/VOIDED, tenant isolation aplicada lá.
   *   3. Calcula totais por método de pagamento.
   *   4. Devolve {@link ReconciliationSummary} com `generatedAt` em ISO.
   */
  public async getReconciliation(
    query: ReconciliationQuery,
  ): Promise<Result<ReconciliationSummary, ReconciliationError>> {
    const dateError = validateDateRange(query);
    if (dateError !== null) {
      return err(dateError);
    }

    const records: ReconciliationRecord[] =
      await this.transactionRepository.listForReconciliation(query);

    const summary: ReconciliationSummary = {
      records,
      totalsByMethod: totalsByMethod(records),
      generatedAt: new Date().toISOString(),
    };
    return ok(summary);
  }

  /**
   * Cria um job de export assíncrono (req 5.5).
   *
   * Diferente de {@link getReconciliation}, este método **sempre**
   * enfileira (a comparação contra `RECONCILIATION_ASYNC_THRESHOLD` é
   * usada apenas pela rota `GET /reconciliation` para decidir entre
   * inline ou redirect; a rota `POST /reconciliation/jobs` chama este
   * método diretamente — cf. design.md "Batch / Job Contract"). Ainda
   * fazemos a mesma validação de date range (req 5.3) para devolver
   * 400 cedo.
   *
   * Deduplicação: hash sha256 da query normalizada. Se já existe um job
   * QUEUED/PROCESSING/COMPLETED com o mesmo hash em < 1h, devolve o
   * existente sem criar novo (design.md "Idempotency & recovery").
   *
   * TODO(integration): a estimativa baseada em
   * `RECONCILIATION_ASYNC_THRESHOLD` (env padrão 10_000) será aplicada
   * pela rota `GET /reconciliation` na task 13.1 — quando o `total`
   * via `transactionRepository.list({ ..., pageSize: 1 })` exceder o
   * threshold, redirecionamos o cliente para criar um job aqui.
   */
  public async createExportJob(
    query: ReconciliationQuery,
  ): Promise<Result<ReconciliationJob, ReconciliationError>> {
    const dateError = validateDateRange(query);
    if (dateError !== null) {
      return err(dateError);
    }

    if (this.queue === null) {
      // Defesa de configuração: serviço sem queue não pode criar job.
      // Retorna NOT_FOUND para evitar leaking interno; em produção o
      // bootstrap sempre provê o queue.
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }

    const queryHash = hashQuery(query);
    const existing = await this.queue.findRecentByHash(queryHash);
    if (existing !== null) {
      return ok(existing);
    }

    const enqueued = await this.queue.enqueue(query);
    return ok({
      jobId: enqueued.jobId,
      status: enqueued.status,
      resultUrl: null,
    });
  }

  /**
   * Polling de status do job (req 5.5). Delega ao queue, que lê o
   * espelho Postgres como fonte de verdade.
   */
  public async getJobStatus(
    jobId: string,
  ): Promise<Result<ReconciliationJob, ReconciliationError>> {
    if (this.queue === null) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }
    return this.queue.getJobStatus(jobId);
  }
}
