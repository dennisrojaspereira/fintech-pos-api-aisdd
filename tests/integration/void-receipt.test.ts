/**
 * Integration tests — POST /v1/transactions/:id/void e GET
 * /v1/transactions/:id/receipt (Task 16.2).
 *
 * Reqs cobertos: 3.1, 3.2, 3.3, 4.1, 4.2, 4.5.
 *
 * Pre-requisito de execucao:
 *   $ docker compose up -d   # postgres + redis prontos
 *   $ npm run prisma:deploy  # migrations aplicadas em posapi_test
 *
 * Estrategia:
 *   - Stub do `AcquirerAdapter.void` via `vi.mock(...)` — mesmo padrao
 *     do 16.1. Postgres + Redis REAIS via docker-compose.
 *   - Cada teste seeda a transacao alvo direto via Prisma com o status
 *     desejado (sem passar pela rota authorize).
 *   - JWT RS256 com scopes `transactions:void` e `transactions:read`.
 *   - HTTP via `app.inject()`.
 */

// 1) JWT pre-load
import { injectTestPublicKey, signTestJwt, bearer } from '../setup/jwt.js';
injectTestPublicKey();

// 2) .env.test
import '../setup/env.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Result } from '../../src/shared/result.js';
import type {
  AcquirerAdapterError,
  AcquirerAuthRequest,
  AcquirerResult,
  AcquirerVoidRequest,
} from '../../src/shared/types.js';

// ─────────────────────────────────────────────
// vi.mock do AcquirerAdapter
// ─────────────────────────────────────────────

type MockVoidOutcome =
  | { kind: 'APPROVED' }
  | { kind: 'DECLINED'; declineCode?: string }
  | { kind: 'CIRCUIT_OPEN' };

let voidOutcome: MockVoidOutcome = { kind: 'APPROVED' };

function setVoidOutcome(o: MockVoidOutcome): void {
  voidOutcome = o;
}

function buildVoidResult(): Result<AcquirerResult, AcquirerAdapterError> {
  switch (voidOutcome.kind) {
    case 'APPROVED':
      return {
        ok: true,
        value: {
          outcome: 'APPROVED',
          authorizationCode: 'VOID-OK',
          acquirerReferenceNumber: 'VOID-REF',
          declineCode: null,
          rawResponseCode: '200',
        },
      };
    case 'DECLINED':
      return {
        ok: true,
        value: {
          outcome: 'DECLINED',
          authorizationCode: null,
          acquirerReferenceNumber: null,
          declineCode: voidOutcome.declineCode ?? 'VOID_REJECTED',
          rawResponseCode: '402',
        },
      };
    case 'CIRCUIT_OPEN':
      return {
        ok: false,
        error: { code: 'CIRCUIT_OPEN', httpStatus: 503, retryAfterSeconds: 30 },
      };
  }
}

vi.mock('../../src/infra/acquirer/acquirer-adapter.js', () => {
  const stub = {
    authorize: vi.fn(
      async (_req: AcquirerAuthRequest): Promise<Result<AcquirerResult, AcquirerAdapterError>> => ({
        ok: true,
        value: {
          outcome: 'APPROVED',
          authorizationCode: 'AUTH-DEFAULT',
          acquirerReferenceNumber: 'REF-DEFAULT',
          declineCode: null,
          rawResponseCode: '200',
        },
      }),
    ),
    void: vi.fn(async (_req: AcquirerVoidRequest) => buildVoidResult()),
  };
  class AcquirerAdapter {
    public async authorize(
      req: AcquirerAuthRequest,
    ): Promise<Result<AcquirerResult, AcquirerAdapterError>> {
      return stub.authorize(req);
    }
    public async void(
      req: AcquirerVoidRequest,
    ): Promise<Result<AcquirerResult, AcquirerAdapterError>> {
      return stub.void(req);
    }
  }
  return {
    AcquirerAdapter,
    acquirerAdapter: stub,
  };
});

// ─────────────────────────────────────────────
// Imports apos vi.mock
// ─────────────────────────────────────────────

import { buildServer } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import {
  cleanDatabaseReal,
  disposeRealClients,
  flushRedisReal,
  getPrisma,
  seedMerchantReal,
  seedTransactionReal,
} from '../setup/db.js';
import { TransactionStatus } from '../../src/shared/enums.js';

// ─────────────────────────────────────────────
// Setup global
// ─────────────────────────────────────────────

let app: FastifyInstance;
let merchantId: string;
let terminalId: string;
const operatorId = 'op-tester-2';

const allScopes: readonly string[] = [
  'transactions:write',
  'transactions:read',
  'transactions:void',
];

function authHeader(): string {
  return bearer(
    signTestJwt({
      merchantId,
      terminalId,
      operatorId,
      scopes: allScopes,
      accountStatus: 'ACTIVE',
    }),
  );
}

beforeAll(async () => {
  const env = loadEnv();
  app = await buildServer({ env });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disposeRealClients();
});

beforeEach(async () => {
  setVoidOutcome({ kind: 'APPROVED' });
  await cleanDatabaseReal();
  await flushRedisReal();
  const seeded = await seedMerchantReal({ name: 'Loja Void+Receipt' });
  merchantId = seeded.id;
  terminalId = seeded.terminalId;
});

// ─────────────────────────────────────────────
// Tests — VOID
// ─────────────────────────────────────────────

describe('POST /v1/transactions/:id/void — APPROVED → VOIDED (req 3.1, 3.3)', () => {
  it('updates status to VOIDED and records voidedAt + voidedBy', async () => {
    setVoidOutcome({ kind: 'APPROVED' });

    const seededTx = await seedTransactionReal({
      merchantId,
      terminalId,
      status: TransactionStatus.APPROVED,
      authorizationCode: 'AUTH-TO-VOID',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/transactions/${seededTx.id}/void`,
      headers: { authorization: authHeader() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['transactionId']).toBe(seededTx.id);
    expect(body['status']).toBe('VOIDED');
    expect(typeof body['voidedAt']).toBe('string');
    expect(body['voidedBy']).toBe(operatorId);

    const prisma = getPrisma();
    const row = await prisma.transaction.findUnique({ where: { id: seededTx.id } });
    expect(row?.status).toBe('VOIDED');
    expect(row?.voidedBy).toBe(operatorId);
    expect(row?.voidedAt).not.toBeNull();
  });
});

describe('POST /v1/transactions/:id/void — state guards (req 3.2)', () => {
  const guardCases: ReadonlyArray<TransactionStatus> = [
    TransactionStatus.VOIDED,
    TransactionStatus.SETTLED,
    TransactionStatus.DECLINED,
  ];

  for (const seedStatus of guardCases) {
    it(`returns 409 with currentStatus when transaction is ${seedStatus}`, async () => {
      setVoidOutcome({ kind: 'APPROVED' });

      const seededTx = await seedTransactionReal({
        merchantId,
        terminalId,
        status: seedStatus,
        authorizationCode:
          seedStatus === TransactionStatus.DECLINED ? null : 'AUTH-X',
        voidedAt: seedStatus === TransactionStatus.VOIDED ? new Date() : null,
        voidedBy: seedStatus === TransactionStatus.VOIDED ? 'op-prev' : null,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/transactions/${seededTx.id}/void`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json() as Record<string, unknown>;
      // O error-serializer expoe `currentStatus` no envelope. Em
      // alguns serializers o campo fica em `body.error.currentStatus`,
      // em outros no top-level. Aceitamos ambos.
      const top = body['currentStatus'];
      const fromEnvelope =
        typeof body['error'] === 'object' && body['error'] !== null
          ? (body['error'] as Record<string, unknown>)['currentStatus']
          : undefined;
      const value = top ?? fromEnvelope;
      expect(value).toBe(seedStatus);
    });
  }
});

// ─────────────────────────────────────────────
// Tests — RECEIPT
// ─────────────────────────────────────────────

describe('GET /v1/transactions/:id/receipt — APPROVED + VOIDED (req 4.1, 4.5)', () => {
  it('returns receipt payload for APPROVED transaction', async () => {
    const seededTx = await seedTransactionReal({
      merchantId,
      terminalId,
      status: TransactionStatus.APPROVED,
      authorizationCode: 'AUTH-RCT-1',
      maskedPan: '****9876',
      paymentMethodType: 'CREDIT_CARD',
      amount: 2500,
      currency: 'BRL',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/transactions/${seededTx.id}/receipt`,
      headers: { authorization: authHeader() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['transactionId']).toBe(seededTx.id);
    expect(body['merchantName']).toBe('Loja Void+Receipt');
    expect(body['terminalId']).toBe(terminalId);
    expect(body['amount']).toBe(2500);
    expect(body['currency']).toBe('BRL');
    expect(body['paymentMethodType']).toBe('CREDIT_CARD');
    expect(body['maskedPan']).toBe('****9876');
    expect(body['authorizationCode']).toBe('AUTH-RCT-1');
    expect(typeof body['transactionTimestamp']).toBe('string');
  });

  it('returns receipt payload for VOIDED transaction', async () => {
    const seededTx = await seedTransactionReal({
      merchantId,
      terminalId,
      status: TransactionStatus.VOIDED,
      authorizationCode: 'AUTH-RCT-V',
      maskedPan: '****1111',
      voidedAt: new Date(),
      voidedBy: operatorId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/transactions/${seededTx.id}/receipt`,
      headers: { authorization: authHeader() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['transactionId']).toBe(seededTx.id);
    expect(body['maskedPan']).toBe('****1111');
    expect(body['authorizationCode']).toBe('AUTH-RCT-V');
  });
});

describe('GET /v1/transactions/:id/receipt — unavailable (req 4.2)', () => {
  const unavailableStatuses: ReadonlyArray<TransactionStatus> = [
    TransactionStatus.DECLINED,
    TransactionStatus.PENDING,
  ];

  for (const seedStatus of unavailableStatuses) {
    it(`returns 409 with currentStatus when transaction is ${seedStatus}`, async () => {
      const seededTx = await seedTransactionReal({
        merchantId,
        terminalId,
        status: seedStatus,
        authorizationCode: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${seededTx.id}/receipt`,
        headers: { authorization: authHeader() },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json() as Record<string, unknown>;
      const top = body['currentStatus'];
      const fromEnvelope =
        typeof body['error'] === 'object' && body['error'] !== null
          ? (body['error'] as Record<string, unknown>)['currentStatus']
          : undefined;
      const value = top ?? fromEnvelope;
      expect(value).toBe(seedStatus);
    });
  }
});
