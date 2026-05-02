/**
 * Helpers reais de banco para testes de integracao.
 *
 * Estes helpers complementam (e nao substituem) `seed.ts`. Eles dependem
 * do `PrismaClient` real e sao usados nos testes 16.x quando o
 * `docker compose` esta de pe.
 *
 * Padronizamos:
 *   - `cleanDatabaseReal()`: TRUNCATE em ordem segura (FK first).
 *   - `seedMerchantReal()`: cria um Merchant minimo + Terminal opcional.
 *   - `seedTransactionReal()`: insere uma Transaction direto via Prisma
 *     (bypass de servicos), util para preparar cenarios de void/receipt.
 *   - `flushRedisReal()`: FLUSHDB no Redis configurado em REDIS_URL.
 *
 * Nota: `tests/setup/seed.ts` continua valendo como contrato; estas
 * funcoes sao a implementacao concreta que estava marcada como TODO
 * naquele arquivo (sem modifica-lo).
 */

import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { TransactionStatus } from '../../src/shared/enums.js';

let _prisma: PrismaClient | null = null;
let _redis: Redis | null = null;

export function getPrisma(): PrismaClient {
  if (_prisma === null) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}

export function getRedis(): Redis {
  if (_redis === null) {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379/1';
    _redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableReadyCheck: true,
    });
  }
  return _redis;
}

/**
 * Trunca todas as tabelas usadas pelos cenarios de integracao. A ordem
 * importa por causa das FKs: filhas antes de pais.
 */
export async function cleanDatabaseReal(): Promise<void> {
  const prisma = getPrisma();
  // deleteMany em vez de TRUNCATE para permitir rodar sem privilegio
  // de owner. Em testes a quantidade de linhas e pequena.
  await prisma.auditEntry.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.reconciliationJob.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.merchant.deleteMany();
}

export async function flushRedisReal(): Promise<void> {
  const redis = getRedis();
  // FLUSHDB so afeta o DB selecionado (REDIS_URL aponta para .../1).
  await redis.flushdb();
}

export interface SeedMerchantRealInput {
  readonly id?: string;
  readonly name?: string;
  readonly accountStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  readonly receiptTemplateId?: string | null;
  readonly terminalId?: string;
}

export interface SeededMerchantReal {
  readonly id: string;
  readonly name: string;
  readonly accountStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  readonly receiptTemplateId: string | null;
  readonly terminalId: string;
}

export async function seedMerchantReal(
  input: SeedMerchantRealInput = {},
): Promise<SeededMerchantReal> {
  const prisma = getPrisma();
  const id = input.id ?? randomUUID();
  const name = input.name ?? 'Test Merchant';
  const accountStatus = input.accountStatus ?? 'ACTIVE';
  const receiptTemplateId = input.receiptTemplateId ?? null;
  const terminalId = input.terminalId ?? `term-${id.slice(0, 8)}`;

  await prisma.merchant.create({
    data: {
      id,
      name,
      accountStatus,
      receiptTemplateId,
    },
  });

  await prisma.terminal.create({
    data: {
      id: terminalId,
      merchantId: id,
      label: `Terminal ${terminalId}`,
    },
  });

  return {
    id,
    name,
    accountStatus,
    receiptTemplateId,
    terminalId,
  };
}

export interface SeedTransactionRealInput {
  readonly merchantId: string;
  readonly terminalId: string;
  readonly status: TransactionStatus;
  readonly amount?: number;
  readonly currency?: string;
  readonly authorizationCode?: string | null;
  readonly maskedPan?: string;
  readonly paymentMethodType?: 'CREDIT_CARD' | 'DEBIT_CARD' | 'CONTACTLESS_NFC';
  readonly voidedAt?: Date | null;
  readonly voidedBy?: string | null;
  readonly acquirerReferenceNumber?: string | null;
  readonly acquirerDeclineCode?: string | null;
}

export interface SeededTransactionReal {
  readonly id: string;
}

export async function seedTransactionReal(
  input: SeedTransactionRealInput,
): Promise<SeededTransactionReal> {
  const prisma = getPrisma();
  const id = randomUUID();
  await prisma.transaction.create({
    data: {
      id,
      merchantId: input.merchantId,
      terminalId: input.terminalId,
      amount: input.amount ?? 1000,
      currency: input.currency ?? 'BRL',
      paymentMethodType: input.paymentMethodType ?? 'CREDIT_CARD',
      maskedPan: input.maskedPan ?? '****1234',
      status: input.status,
      authorizationCode:
        input.authorizationCode === undefined
          ? input.status === 'APPROVED' || input.status === 'VOIDED' || input.status === 'SETTLED'
            ? 'AUTH-SEED'
            : null
          : input.authorizationCode,
      acquirerReferenceNumber: input.acquirerReferenceNumber ?? null,
      acquirerDeclineCode: input.acquirerDeclineCode ?? null,
      voidedAt: input.voidedAt ?? null,
      voidedBy: input.voidedBy ?? null,
    },
  });
  return { id };
}

/**
 * Encerra os clientes singletons. Chamar em afterAll para liberar
 * conexoes; sem isso, o vitest nao desliga o processo de teste.
 */
export async function disposeRealClients(): Promise<void> {
  if (_prisma !== null) {
    await _prisma.$disconnect();
    _prisma = null;
  }
  if (_redis !== null) {
    _redis.disconnect();
    _redis = null;
  }
}
