/**
 * Integration tests — POST /v1/transactions (Task 16.1).
 *
 * Reqs cobertos: 1.1, 1.4, 1.5, 1.6, 7.1, 7.4.
 *
 * Pre-requisito de execucao:
 *   $ docker compose up -d   # postgres + redis prontos
 *   $ npm run prisma:deploy  # migrations aplicadas em posapi_test
 *
 * Estrategia:
 *   - Stub do `AcquirerAdapter` via `vi.mock(...)`. Trocamos a
 *     implementacao publica do modulo para que o `transactionService`
 *     (que importa `acquirerAdapter` por nome) consuma um adapter
 *     controlavel test-a-test.
 *   - Postgres + Redis REAIS via docker-compose. Limpeza em
 *     `beforeEach` via prisma.deleteMany + redis.flushdb.
 *   - JWT RS256 assinado com keypair gerado em runtime; chave publica
 *     injetada em `process.env.JWT_PUBLIC_KEY` ANTES de carregar o env.
 *   - HTTP via `app.inject()` — nao subimos servidor real.
 *
 * Decisoes de design dos testes:
 *   - O stub default do mock e "APPROVED" para nao atrapalhar testes
 *     que nao se importem com o acquirer; cada test reconfigura via
 *     `setMockAcquirerOutcome(...)`.
 */

// 1) JWT pre-load: injeta a chave publica antes do env.ts ler `process.env`.
import { injectTestPublicKey, signTestJwt, bearer } from '../setup/jwt.js';
injectTestPublicKey();

// 2) Carrega .env.test (loader nao sobrescreve chaves ja definidas).
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
// vi.mock do AcquirerAdapter — DEVE ficar no topo do arquivo.
// ─────────────────────────────────────────────

type MockAcquirerOutcome =
  | { kind: 'APPROVED'; authCode?: string; arn?: string }
  | { kind: 'DECLINED'; declineCode?: string }
  | { kind: 'TIMEOUT' }
  | { kind: 'CIRCUIT_OPEN' };

let currentOutcome: MockAcquirerOutcome = { kind: 'APPROVED' };

function setMockAcquirerOutcome(o: MockAcquirerOutcome): void {
  currentOutcome = o;
}

function buildAuthorizeResult(): Result<AcquirerResult, AcquirerAdapterError> {
  switch (currentOutcome.kind) {
    case 'APPROVED':
      return {
        ok: true,
        value: {
          outcome: 'APPROVED',
          authorizationCode: currentOutcome.authCode ?? 'AUTH1',
          acquirerReferenceNumber: currentOutcome.arn ?? 'REF1',
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
          declineCode: currentOutcome.declineCode ?? 'INSUFFICIENT_FUNDS',
          rawResponseCode: '402',
        },
      };
    case 'TIMEOUT':
      return {
        ok: true,
        value: {
          outcome: 'TIMEOUT',
          authorizationCode: null,
          acquirerReferenceNumber: null,
          declineCode: null,
          rawResponseCode: null,
        },
      };
    case 'CIRCUIT_OPEN':
      return {
        ok: false,
        error: {
          code: 'CIRCUIT_OPEN',
          httpStatus: 503,
          retryAfterSeconds: 30,
        },
      };
  }
}

vi.mock('../../src/infra/acquirer/acquirer-adapter.js', () => {
  // O adapter exposto e: classe `AcquirerAdapter` + singleton
  // `acquirerAdapter`. Entregamos ambos com authorize/void controlaveis.
  const stub = {
    authorize: vi.fn(async (_req: AcquirerAuthRequest) => buildAuthorizeResult()),
    void: vi.fn(async (_req: AcquirerVoidRequest) => buildAuthorizeResult()),
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
    __mockHandle: stub,
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
} from '../setup/db.js';

// ─────────────────────────────────────────────
// Setup global
// ─────────────────────────────────────────────

let app: FastifyInstance;
let merchantId: string;
let terminalId: string;
const operatorId = 'op-tester-1';

const baseScopes: readonly string[] = ['transactions:write', 'transactions:read'];

function authHeader(): string {
  return bearer(
    signTestJwt({
      merchantId,
      terminalId,
      operatorId,
      scopes: baseScopes,
      accountStatus: 'ACTIVE',
    }),
  );
}

function authorizeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: 1500,
    currency: 'BRL',
    terminalId,
    paymentMethod: {
      type: 'CREDIT_CARD',
      maskedPan: '****1234',
      expiryMonth: 12,
      expiryYear: 2030,
    },
    ...overrides,
  };
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
  setMockAcquirerOutcome({ kind: 'APPROVED' });
  await cleanDatabaseReal();
  await flushRedisReal();
  const seeded = await seedMerchantReal({ name: 'Test Loja' });
  merchantId = seeded.id;
  terminalId = seeded.terminalId;
});

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('POST /v1/transactions — APPROVED flow (req 1.1, 1.4, 1.5)', () => {
  it('persists a transaction, writes audit log, and stores the idempotency key', async () => {
    setMockAcquirerOutcome({ kind: 'APPROVED', authCode: 'AUTH1', arn: 'REF1' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: {
        authorization: authHeader(),
        'idempotency-key': 'idem-approved-1',
        'content-type': 'application/json',
      },
      payload: authorizeBody(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('APPROVED');
    expect(body['authorizationCode']).toBe('AUTH1');
    expect(typeof body['transactionId']).toBe('string');

    const prisma = getPrisma();
    const txs = await prisma.transaction.findMany({ where: { merchantId } });
    expect(txs.length).toBe(1);
    expect(txs[0]?.status).toBe('APPROVED');

    const audits = await prisma.auditEntry.findMany({ where: { resourceId: txs[0]!.id } });
    expect(audits.length).toBe(1);
    expect(audits[0]?.action).toBe('AUTHORIZE');
    expect(audits[0]?.outcome).toBe('SUCCESS');

    // O idempotency store usa prefixo `idemp:` (ver idempotency-store.ts).
    const { getRedis } = await import('../setup/db.js');
    const cached = await getRedis().get('idemp:idem-approved-1');
    expect(cached).not.toBeNull();
  });
});

describe('POST /v1/transactions — DECLINED flow (req 1.5)', () => {
  it('returns 200 with status DECLINED and decline code', async () => {
    setMockAcquirerOutcome({ kind: 'DECLINED', declineCode: 'INSUFFICIENT_FUNDS' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: {
        authorization: authHeader(),
        'idempotency-key': 'idem-declined-1',
        'content-type': 'application/json',
      },
      payload: authorizeBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('DECLINED');
    expect(body['acquirerDeclineCode']).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('POST /v1/transactions — PENDING (TIMEOUT) flow (req 1.6)', () => {
  it('returns 202 with status PENDING and reflects PENDING + lastAcquirerCheckAt on subsequent GET', async () => {
    setMockAcquirerOutcome({ kind: 'TIMEOUT' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: {
        authorization: authHeader(),
        'idempotency-key': 'idem-pending-1',
        'content-type': 'application/json',
      },
      payload: authorizeBody(),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('PENDING');
    const txId = body['transactionId'] as string;
    expect(typeof txId).toBe('string');

    // Subsequent GET — req 2.3: PENDING tx deve ter lastAcquirerCheckAt
    // populado apos a leitura (re-poll path).
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/transactions/${txId}`,
      headers: { authorization: authHeader() },
    });
    expect(getRes.statusCode).toBe(200);
    const record = getRes.json() as Record<string, unknown>;
    expect(record['status']).toBe('PENDING');
    expect(record['lastAcquirerCheckAt']).not.toBeNull();
  });
});

describe('POST /v1/transactions — Idempotency replay (req 7.1, 7.4)', () => {
  it('returns the same response on a second call with the same Idempotency-Key and sets the replay header', async () => {
    setMockAcquirerOutcome({ kind: 'APPROVED', authCode: 'AUTH-REPLAY' });

    const idemKey = 'idem-replay-1';
    const headers = {
      authorization: authHeader(),
      'idempotency-key': idemKey,
      'content-type': 'application/json',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers,
      payload: authorizeBody(),
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as Record<string, unknown>;

    const second = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers,
      payload: authorizeBody(),
    });

    // Status code deve replicar o original.
    expect(second.statusCode).toBe(201);
    // Header `Idempotent-Replayed: true` (case-insensitive).
    const replayHeader = second.headers['idempotent-replayed'];
    expect(replayHeader).toBe('true');
    const secondBody = second.json() as Record<string, unknown>;
    expect(secondBody['transactionId']).toBe(firstBody['transactionId']);
    expect(secondBody['authorizationCode']).toBe(firstBody['authorizationCode']);

    // Apenas UM registro persistido (replay nao chama domain).
    const prisma = getPrisma();
    const txs = await prisma.transaction.findMany({ where: { merchantId } });
    expect(txs.length).toBe(1);
  });
});
