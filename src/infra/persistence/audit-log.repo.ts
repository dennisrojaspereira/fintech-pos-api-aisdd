/**
 * Audit log repository — persistência append-only de audit entries.
 *
 * Source: design.md "Audit Log Repository" + requirements 8.3, 8.4.
 *
 * Contrato crítico (req 8.4):
 *   - `write()` NUNCA rejeita ao caller — toda falha é silenciada via
 *     try/catch interno. Isso garante que falha de auditoria não
 *     derrube o fluxo de negócio (autorização, void, etc.).
 *   - Em caso de falha, emite uma métrica OTel
 *     `audit_log_write_failures_total` (Counter) e loga no console
 *     como fallback (TODO substituir por pino quando Task 14.1 prover
 *     o logger central).
 *
 * Append-only: a tabela audit_entries não permite UPDATE/DELETE
 * (revogado em SQL pela Task 2.2). Aqui só fazemos INSERT.
 *
 * Observação técnica: como `prisma generate` não roda neste ambiente
 * (sem rede), `PrismaClient` vem como `any` do pacote @prisma/client.
 * Não importamos tipos de model do namespace Prisma porque eles só
 * existem após generate.
 */

import { PrismaClient } from '@prisma/client';
import { metrics, type Counter } from '@opentelemetry/api';

import type { AuditEntry } from '../../shared/types.js';
import { prisma as defaultPrisma } from './prisma.js';

/**
 * Entrada de auditoria a ser persistida. `id` é gerado pelo banco
 * (default UUID). `timestamp` é opcional — quando omitido, o banco
 * usa default now().
 */
export type AuditWriteInput = Omit<AuditEntry, 'id' | 'timestamp'> & {
  readonly timestamp?: string | undefined;
};

const meter = metrics.getMeter('fintech-pos-api', '0.1.0');

const auditWriteFailuresCounter: Counter = meter.createCounter(
  'audit_log_write_failures_total',
  {
    description:
      'Total number of failures persisting audit entries (req 8.4 — non-blocking, critical alert).',
  },
);

export class AuditLogRepository {
  private readonly client: PrismaClient;

  public constructor(client: PrismaClient = defaultPrisma) {
    this.client = client;
  }

  /**
   * Fire-and-forget write. Resolve sempre com void; em falha,
   * incrementa o contador e loga error. Nunca lança / rejeita
   * (req 8.4 — audit log failure must NOT fail business operation).
   */
  public async write(entry: AuditWriteInput): Promise<void> {
    try {
      const data: Record<string, unknown> = {
        actorId: entry.actorId,
        action: entry.action,
        resourceId: entry.resourceId,
        outcome: entry.outcome,
        metadata: entry.metadata ?? {},
      };
      if (entry.timestamp !== undefined) {
        data['timestamp'] = new Date(entry.timestamp);
      }
      await this.client.auditEntry.create({ data });
    } catch (error) {
      this.handleFailure(entry, error);
    }
  }

  private handleFailure(entry: AuditWriteInput, error: unknown): void {
    try {
      auditWriteFailuresCounter.add(1, {
        action: entry.action,
        outcome: entry.outcome,
      });
    } catch {
      // Métrica nunca pode propagar — fallback silencioso.
    }
    // TODO(Task 14.1): substituir console.error por pino central.
    // eslint-disable-next-line no-console
    console.error('[audit-log] write failed (non-blocking)', {
      action: entry.action,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
  }
}

export const auditLogRepository = new AuditLogRepository();
