/**
 * Reconciliation export queue — BullMQ + Postgres twin record.
 *
 * Source:
 *   - design.md "Reconciliation Job Queue" (Components and Interfaces)
 *   - design.md "Batch / Job Contract" (Reconciliation Service)
 *   - requirements.md 5.5 (async export with polling)
 *   - tasks.md task 12.2
 *
 * Estratégia:
 *   - Dois espelhos: (a) `prisma.reconciliationJob` é o registro
 *     durável — fonte de verdade do status visível ao cliente; (b) BullMQ
 *     é o broker de execução que carrega o `ReconciliationQuery` para o
 *     worker. O `id` da row Postgres é reusado como `jobId` no BullMQ
 *     para que polling e dedup sejam triviais (req 5.5).
 *   - Deduplicação: hash sha256 da query normalizada (`queryHash`). Se já
 *     existe um job não-FAILED criado em < 1h com o mesmo hash, devolvemos
 *     o existente sem criar novo (design.md "Idempotency & recovery:
 *     duplicate job submissions for the same query within 1 hour are
 *     deduplicated by job name hash"). A camada de serviço faz essa
 *     verificação antes de chamar `enqueueReconciliationJob`.
 *   - Worker: NÃO inicializado neste módulo. Apenas exportamos a factory
 *     {@link createReconciliationWorker} para o `src/index.ts` ligar
 *     na fase de integração (TODO referenciado na task 13.x).
 *   - Conexão Redis: BullMQ aceita uma string de URL ou um objeto
 *     `ConnectionOptions`. Passamos URL via parâmetro do construtor
 *     (carregado de `env.REDIS_URL` no bootstrap). O builder
 *     {@link buildReconciliationQueue} é exportado para os routers/tests
 *     instanciarem com a URL desejada.
 */

import { createHash } from 'node:crypto';

import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';

import { prisma as defaultPrisma } from '../persistence/prisma.js';
import { ReconciliationJobStatus } from '../../shared/enums.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  ReconciliationError,
  ReconciliationJob,
  ReconciliationQuery,
} from '../../shared/types.js';

/** Nome canônico da fila BullMQ (design.md "Reconciliation Job Queue"). */
export const RECONCILIATION_QUEUE_NAME = 'reconciliation-export';

/** Janela de deduplicação de jobs com mesma query (design.md). */
export const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hora

/**
 * Serializa o `ReconciliationQuery` em uma forma canônica e estável
 * para hashing. Ordenamos as chaves e omitimos `pageSize` (não muda
 * semanticamente os dados retornados em export bulk).
 */
function normalizeQuery(query: ReconciliationQuery): string {
  // Mantém apenas chaves load-bearing para o conteúdo do export.
  const canonical = {
    merchantId: query.merchantId,
    terminalId: query.terminalId ?? null,
    startDate: query.startDate,
    endDate: query.endDate,
  };
  return JSON.stringify(canonical);
}

/**
 * Hash sha256 hex da query — usado como `queryHash` no Postgres e como
 * `name` no BullMQ para visibilidade nos paineis de monitoring.
 */
export function hashQuery(query: ReconciliationQuery): string {
  return createHash('sha256').update(normalizeQuery(query)).digest('hex');
}

/**
 * Tipo do client Prisma — `any` por causa da nota técnica em
 * `transaction.repo.ts`: este projeto não roda `prisma generate` no
 * sandbox.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

/** Linha bruta da tabela `reconciliation_jobs`. Espelha schema.prisma. */
interface PrismaReconciliationJobRow {
  id: string;
  merchantId: string;
  terminalId: string | null;
  startDate: Date;
  endDate: Date;
  status: string;
  resultUrl: string | null;
  queryHash: string;
  createdAt: Date;
  updatedAt: Date;
}

function toReconciliationJob(row: PrismaReconciliationJobRow): ReconciliationJob {
  return {
    jobId: row.id,
    status: row.status as ReconciliationJobStatus,
    resultUrl: row.resultUrl,
  };
}

/**
 * Wrapper sobre BullMQ + Postgres expondo apenas as operações de
 * negócio que a {@link import('../../domain/reconciliation/reconciliation.service.js').ReconciliationService}
 * precisa. Decoupla testes e bootstrap.
 */
export class ReconciliationQueue {
  private readonly queue: Queue;
  private readonly prisma: PrismaLike;
  private readonly nowFn: () => Date;

  public constructor(
    options: {
      readonly connection: ConnectionOptions;
      readonly prismaClient?: PrismaLike;
      readonly nowFn?: () => Date;
    },
  ) {
    this.queue = new Queue(RECONCILIATION_QUEUE_NAME, {
      connection: options.connection,
    });
    this.prisma = options.prismaClient ?? defaultPrisma;
    this.nowFn = options.nowFn ?? ((): Date => new Date());
  }

  /**
   * Procura um job não-FAILED para a mesma `queryHash` criado dentro da
   * janela de dedup (1h). Quando encontra, devolve-o; caso contrário,
   * resolve `null`. A camada de serviço usa isso antes de chamar
   * {@link enqueue} (req 5.5 + design.md "Idempotency & recovery").
   */
  public async findRecentByHash(
    queryHash: string,
  ): Promise<ReconciliationJob | null> {
    const cutoff = new Date(this.nowFn().getTime() - DEDUP_WINDOW_MS);
    const row: PrismaReconciliationJobRow | null =
      await this.prisma.reconciliationJob.findFirst({
        where: {
          queryHash,
          createdAt: { gte: cutoff },
          status: {
            in: [
              ReconciliationJobStatus.QUEUED,
              ReconciliationJobStatus.PROCESSING,
              ReconciliationJobStatus.COMPLETED,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    return row ? toReconciliationJob(row) : null;
  }

  /**
   * Cria registro persistente em `reconciliation_jobs` e enfileira no
   * BullMQ. O `jobId` do BullMQ é o id da row, garantindo correlação 1:1
   * para polling. O `name` do job recebe o `queryHash` para tornar a
   * dedup visível nos dashboards (req 5.5).
   *
   * Observações:
   *   - `jobId` único no BullMQ é a defesa final contra duplicatas
   *     concorrentes — adicionar duas vezes com o mesmo id é no-op.
   *   - A tabela registra `startDate`/`endDate` como `@db.Date`: passamos
   *     as strings ISO 8601 já recebidas (Prisma converte).
   */
  public async enqueue(
    query: ReconciliationQuery,
  ): Promise<{ readonly jobId: string; readonly status: 'QUEUED' }> {
    const queryHash = hashQuery(query);

    const row: PrismaReconciliationJobRow =
      await this.prisma.reconciliationJob.create({
        data: {
          merchantId: query.merchantId,
          terminalId: query.terminalId ?? null,
          startDate: new Date(query.startDate),
          endDate: new Date(query.endDate),
          status: ReconciliationJobStatus.QUEUED,
          queryHash,
        },
      });

    await this.queue.add(
      queryHash,
      // Payload do job — o worker recebe a query completa para executar
      // o export. Mantemos só campos puros (string/null/number) para
      // evitar problemas de serialização do BullMQ.
      {
        jobId: row.id,
        merchantId: query.merchantId,
        terminalId: query.terminalId ?? null,
        startDate: query.startDate,
        endDate: query.endDate,
        ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      },
      {
        jobId: row.id,
      },
    );

    return { jobId: row.id, status: 'QUEUED' };
  }

  /**
   * Lê o status do job a partir do espelho Postgres (não do BullMQ).
   * O Postgres é a fonte de verdade externa: o worker é responsável por
   * promover `QUEUED → PROCESSING → COMPLETED|FAILED` ali.
   *
   * Retorna `NOT_FOUND` quando o id não existe (404 na rota — req 5.5).
   */
  public async getJobStatus(
    jobId: string,
  ): Promise<Result<ReconciliationJob, ReconciliationError>> {
    const row: PrismaReconciliationJobRow | null =
      await this.prisma.reconciliationJob.findUnique({
        where: { id: jobId },
      });
    if (!row) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }
    return ok(toReconciliationJob(row));
  }

  /** Acesso ao Queue subjacente — útil para fechar conexões em testes. */
  public getRawQueue(): Queue {
    return this.queue;
  }
}

/**
 * Factory para o BullMQ Worker. NÃO é inicializada por este módulo —
 * deve ser chamada explicitamente a partir do `src/index.ts` (ou de um
 * worker process dedicado) durante a fase de integração.
 *
 * TODO(integration): conectar este factory ao bootstrap em `src/index.ts`
 * passando a `processFn` que executa o export e atualiza
 * `reconciliation_jobs.status` para `PROCESSING`/`COMPLETED`/`FAILED`
 * + grava `resultUrl` (design.md "Batch / Job Contract").
 */
export function createReconciliationWorker(
  processFn: Processor,
  connection: ConnectionOptions,
): Worker {
  return new Worker(RECONCILIATION_QUEUE_NAME, processFn, { connection });
}
