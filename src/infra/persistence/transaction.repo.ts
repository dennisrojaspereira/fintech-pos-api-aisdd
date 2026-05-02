/**
 * Transaction repository — persistência e leitura de transações.
 *
 * Escopo Task 7.1:
 *   - create(data)              — insere com merchantId obrigatório
 *   - findById(id, merchantId)  — filtro tenant obrigatório (req 6.4)
 *   - updateStatus(...)         — optimistic locking via campo `version`
 *
 * Escopo Task 7.2 (adicionado):
 *   - list(filters)              — paginação + filtros + tenant isolation
 *   - listForReconciliation(q)   — APPROVED/VOIDED por período (reqs 5.1, 5.4)
 *
 * Source: design.md "Transaction Repository" + requirements 1.4, 1.5,
 * 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3, 5.1, 5.4, 6.4. Tipos de retorno
 * vêm de `src/shared/types.ts` — fonte única, não redefinir aqui.
 *
 * Observação técnica: este projeto não roda `prisma generate` neste
 * ambiente (sem rede para o engine), então `PrismaClient` é exportado
 * como `any` pelo pacote `@prisma/client`. Tipamos as rows lidas via
 * uma interface local `PrismaTransactionRow` que reflete o schema.
 */

import { PrismaClient } from '@prisma/client';

import type {
  PaymentMethodType,
  SettlementStatus,
  TransactionStatus,
} from '../../shared/enums.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  PaginatedList,
  ReconciliationQuery,
  ReconciliationRecord,
  TransactionListFilters,
  TransactionRecord,
} from '../../shared/types.js';
import { prisma as defaultPrisma } from './prisma.js';

/**
 * Linha bruta do Prisma para a tabela `transactions`. Espelha o schema
 * declarado em `prisma/schema.prisma`.
 */
interface PrismaTransactionRow {
  id: string;
  merchantId: string;
  terminalId: string;
  amount: number;
  currency: string;
  paymentMethodType: string;
  maskedPan: string;
  status: string;
  authorizationCode: string | null;
  acquirerReferenceNumber: string | null;
  acquirerDeclineCode: string | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  lastAcquirerCheckAt: Date | null;
  settlementStatus: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Cap defensivo de pageSize (reqs 2.5). Evita varreduras inadvertidas. */
const MAX_PAGE_SIZE = 100;

/**
 * Dados aceitos pelo `create()`. Subset de TransactionRecord cobrindo
 * apenas o que pode ser definido na inserção.
 */
export interface CreateTransactionData {
  readonly merchantId: string;
  readonly terminalId: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodType: PaymentMethodType;
  readonly maskedPan: string;
  readonly status: TransactionStatus;
  readonly authorizationCode?: string | null;
  readonly acquirerReferenceNumber?: string | null;
  readonly acquirerDeclineCode?: string | null;
}

/**
 * Metadados opcionais que podem ser gravados junto com `updateStatus`.
 */
export interface UpdateStatusMetadata {
  readonly authorizationCode?: string | null;
  readonly acquirerReferenceNumber?: string | null;
  readonly acquirerDeclineCode?: string | null;
  readonly voidedBy?: string | null;
  readonly voidedAt?: Date | null;
  readonly lastAcquirerCheckAt?: Date | null;
}

export type UpdateStatusError =
  | { readonly code: 'NOT_FOUND' }
  | { readonly code: 'VERSION_CONFLICT' };

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Mapeia a linha bruta do Prisma -> contrato compartilhado
 * `TransactionRecord`. Datas serializadas para ISO 8601.
 */
function toTransactionRecord(row: PrismaTransactionRow): TransactionRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    terminalId: row.terminalId,
    amount: row.amount,
    currency: row.currency,
    paymentMethodType: row.paymentMethodType as PaymentMethodType,
    maskedPan: row.maskedPan,
    status: row.status as TransactionStatus,
    authorizationCode: row.authorizationCode,
    acquirerReferenceNumber: row.acquirerReferenceNumber,
    acquirerDeclineCode: row.acquirerDeclineCode,
    voidedBy: row.voidedBy,
    voidedAt: isoOrNull(row.voidedAt),
    lastAcquirerCheckAt: isoOrNull(row.lastAcquirerCheckAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export class TransactionRepository {
  private readonly client: PrismaClient;

  public constructor(client: PrismaClient = defaultPrisma) {
    this.client = client;
  }

  /**
   * Insere uma nova transação. `merchantId` é mandatório (req 6.4).
   */
  public async create(data: CreateTransactionData): Promise<TransactionRecord> {
    const created: PrismaTransactionRow = await this.client.transaction.create({
      data: {
        merchantId: data.merchantId,
        terminalId: data.terminalId,
        amount: data.amount,
        currency: data.currency,
        paymentMethodType: data.paymentMethodType,
        maskedPan: data.maskedPan,
        status: data.status,
        authorizationCode: data.authorizationCode ?? null,
        acquirerReferenceNumber: data.acquirerReferenceNumber ?? null,
        acquirerDeclineCode: data.acquirerDeclineCode ?? null,
      },
    });
    return toTransactionRecord(created);
  }

  /**
   * Busca por id com isolamento de tenant. Retorna null quando não
   * existe — a camada de serviço traduz para 404 (req 2.2). Nunca lança.
   */
  public async findById(
    id: string,
    merchantId: string,
  ): Promise<TransactionRecord | null> {
    const row: PrismaTransactionRow | null = await this.client.transaction.findFirst({
      where: { id, merchantId },
    });
    return row ? toTransactionRecord(row) : null;
  }

  /**
   * Atualiza o status com optimistic locking. WHERE inclui
   * `version: expectedVersion`; se a linha foi alterada por outro
   * processo, count=0 e retornamos VERSION_CONFLICT. A camada superior
   * decide se relê e tenta novamente.
   *
   * O caller deve ter validado ownership via findById antes; aqui não
   * filtramos por merchantId pois (id, version) já é seguro.
   */
  public async updateStatus(
    id: string,
    expectedVersion: number,
    newStatus: TransactionStatus,
    metadata: UpdateStatusMetadata = {},
  ): Promise<Result<TransactionRecord, UpdateStatusError>> {
    const updateData: Record<string, unknown> = {
      status: newStatus,
      version: { increment: 1 },
    };
    if (metadata.authorizationCode !== undefined) {
      updateData['authorizationCode'] = metadata.authorizationCode;
    }
    if (metadata.acquirerReferenceNumber !== undefined) {
      updateData['acquirerReferenceNumber'] = metadata.acquirerReferenceNumber;
    }
    if (metadata.acquirerDeclineCode !== undefined) {
      updateData['acquirerDeclineCode'] = metadata.acquirerDeclineCode;
    }
    if (metadata.voidedBy !== undefined) {
      updateData['voidedBy'] = metadata.voidedBy;
    }
    if (metadata.voidedAt !== undefined) {
      updateData['voidedAt'] = metadata.voidedAt;
    }
    if (metadata.lastAcquirerCheckAt !== undefined) {
      updateData['lastAcquirerCheckAt'] = metadata.lastAcquirerCheckAt;
    }

    const updateResult: { count: number } = await this.client.transaction.updateMany({
      where: { id, version: expectedVersion },
      data: updateData,
    });

    if (updateResult.count === 0) {
      // Distingue NOT_FOUND vs VERSION_CONFLICT relendo a linha.
      const existing: PrismaTransactionRow | null =
        await this.client.transaction.findUnique({ where: { id } });
      if (!existing) {
        return err({ code: 'NOT_FOUND' });
      }
      return err({ code: 'VERSION_CONFLICT' });
    }

    const reloaded: PrismaTransactionRow | null =
      await this.client.transaction.findUnique({ where: { id } });
    if (!reloaded) {
      // Extremamente improvável — linha sumiu entre update e select.
      return err({ code: 'NOT_FOUND' });
    }
    return ok(toTransactionRecord(reloaded));
  }

  /**
   * Lista paginada de transações com filtros opcionais e tenant isolation.
   *
   * Cobre requisitos 2.5 (paginação + filtros) e 6.4 (tenant isolation).
   * `merchantId` é mandatório; demais filtros são opcionais. `pageSize`
   * é limitado a {@link MAX_PAGE_SIZE} para proteger o banco.
   * Order: `createdAt DESC` (mais recente primeiro).
   *
   * `findMany` e `count` rodam em paralelo via `$transaction` para
   * reduzir latência do endpoint de listagem.
   */
  public async list(
    filters: TransactionListFilters,
  ): Promise<PaginatedList<TransactionRecord>> {
    const page = filters.page < 1 ? 1 : filters.page;
    const requestedPageSize =
      filters.pageSize < 1 ? 1 : filters.pageSize;
    const pageSize =
      requestedPageSize > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : requestedPageSize;

    const where: Record<string, unknown> = { merchantId: filters.merchantId };
    if (filters.terminalId !== undefined) {
      where['terminalId'] = filters.terminalId;
    }
    if (filters.status !== undefined) {
      where['status'] = filters.status;
    }
    if (filters.dateFrom !== undefined || filters.dateTo !== undefined) {
      const createdAt: Record<string, Date> = {};
      if (filters.dateFrom !== undefined) {
        createdAt['gte'] = filters.dateFrom;
      }
      if (filters.dateTo !== undefined) {
        createdAt['lte'] = filters.dateTo;
      }
      where['createdAt'] = createdAt;
    }

    const findManyArgs = {
      where,
      orderBy: { createdAt: 'desc' as const },
      skip: (page - 1) * pageSize,
      take: pageSize,
    };

    const [rows, total]: [PrismaTransactionRow[], number] =
      await this.client.$transaction([
        this.client.transaction.findMany(findManyArgs),
        this.client.transaction.count({ where }),
      ]);

    return {
      items: rows.map(toTransactionRecord),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Lista transações elegíveis para conciliação (status APPROVED ou
   * VOIDED) dentro de um intervalo de datas, com tenant isolation.
   *
   * Cobre requisitos 5.1 (filtros APPROVED + VOIDED), 5.4 (campos do
   * record de conciliação) e 6.4 (tenant isolation). Order: `createdAt
   * ASC` para apresentação cronológica em relatórios de settlement.
   *
   * Datas chegam como strings ISO 8601 em `ReconciliationQuery`; o
   * conversor `new Date(...)` aceita ambos `YYYY-MM-DD` e timestamps
   * completos. Fim de janela é inclusivo (`lte`).
   */
  public async listForReconciliation(
    query: ReconciliationQuery,
  ): Promise<ReconciliationRecord[]> {
    const where: Record<string, unknown> = {
      merchantId: query.merchantId,
      status: { in: ['APPROVED', 'VOIDED'] },
      createdAt: {
        gte: new Date(query.startDate),
        lte: new Date(query.endDate),
      },
    };
    if (query.terminalId !== undefined) {
      where['terminalId'] = query.terminalId;
    }

    const rows: PrismaTransactionRow[] = await this.client.transaction.findMany({
      where,
      orderBy: { createdAt: 'asc' as const },
    });

    return rows.map(toReconciliationRecord);
  }
}

/**
 * Mapeia a linha bruta -> ReconciliationRecord. Campos nullable do
 * schema (`authorizationCode`, `acquirerReferenceNumber`) são
 * convertidos para `''` para satisfazer o tipo (que exige `string` não
 * nulo). TODO: avaliar se rows com esses campos vazios devem ser
 * filtradas a montante em vez de retornadas com placeholder.
 */
function toReconciliationRecord(row: PrismaTransactionRow): ReconciliationRecord {
  return {
    transactionId: row.id,
    amount: row.amount,
    currency: row.currency,
    paymentMethodType: row.paymentMethodType as PaymentMethodType,
    // TODO(7.2): row sem authorizationCode é incomum em APPROVED/VOIDED;
    // log warn se acontecer durante reconciliação.
    authorizationCode: row.authorizationCode ?? '',
    settlementStatus: row.settlementStatus as SettlementStatus,
    // TODO(7.2): mesmo caso para acquirerReferenceNumber.
    acquirerReferenceNumber: row.acquirerReferenceNumber ?? '',
  };
}

export const transactionRepository = new TransactionRepository();
