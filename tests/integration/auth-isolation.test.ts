/**
 * Integration tests — Task 16.3 (Auth + Tenant Isolation).
 *
 * Cobre requirements 6.1, 6.2, 6.3, 6.4, 6.5:
 *   1. JWT ausente -> 401 em todos os endpoints protegidos.
 *   2. JWT valido sem `transactions:void` -> 403 no POST void.
 *   3. JWT sem `reconciliation:read` -> 403 nos endpoints de reconciliation.
 *   4. accountStatus=SUSPENDED -> 403 ACCOUNT_SUSPENDED.
 *   5. accountStatus=INACTIVE -> 403 ACCOUNT_INACTIVE.
 *   6. Cross-tenant: merchant B nao acessa transacao do merchant A.
 *
 * Estrategia:
 *   - Reusa helpers do W5-B em `tests/setup/jwt.ts` e `tests/setup/db.ts`.
 *   - Carrega `.env.test` via `tests/setup/env.ts` apos injectTestPublicKey.
 */

import { injectTestPublicKey, signTestJwt, bearer } from '../setup/jwt.js';
injectTestPublicKey();

import '../setup/env.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import { TransactionStatus } from '../../src/shared/enums.js';
import {
  cleanDatabaseReal,
  disposeRealClients,
  flushRedisReal,
  seedMerchantReal,
  seedTransactionReal,
} from '../setup/db.js';

const MERCHANT_A_ID = '11111111-1111-4111-8111-111111111111';
const MERCHANT_B_ID = '22222222-2222-4222-8222-222222222222';
const SYNTHETIC_TX_ID = '33333333-3333-4333-8333-333333333333';
const RANDOM_JOB_ID = '44444444-4444-4444-8444-444444444444';

const fullScopes: readonly string[] = [
  'transactions:read',
  'transactions:write',
  'transactions:void',
  'reconciliation:read',
];

let app: FastifyInstance;
let merchantATerminalId: string;

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
  await cleanDatabaseReal();
  await flushRedisReal();
  const seeded = await seedMerchantReal({
    id: MERCHANT_A_ID,
    name: 'Merchant A',
  });
  merchantATerminalId = seeded.terminalId;
  await seedMerchantReal({ id: MERCHANT_B_ID, name: 'Merchant B' });
});

describe('Integration — Auth + Tenant Isolation (Task 16.3)', () => {
  // 1) Missing JWT -> 401: cada endpoint protegido individualmente.
  describe('JWT ausente -> 401', () => {
    it('POST /v1/transactions sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: { 'idempotency-key': 'k-no-auth' },
        payload: {
          amount: 100,
          currency: 'USD',
          paymentMethod: {
            type: 'CREDIT_CARD',
            maskedPan: '****1111',
            expiryMonth: 12,
            expiryYear: 2030,
          },
          terminalId: 'terminal-1',
        },
      });
      expect(inj.statusCode).toBe(401);
      const body = inj.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('TOKEN_MISSING');
    });

    it('GET /v1/transactions sem Authorization -> 401', async () => {
      const inj = await app.inject({ method: 'GET', url: '/v1/transactions' });
      expect(inj.statusCode).toBe(401);
    });

    it('GET /v1/transactions/:id sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${SYNTHETIC_TX_ID}`,
      });
      expect(inj.statusCode).toBe(401);
    });

    it('POST /v1/transactions/:id/void sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'POST',
        url: `/v1/transactions/${SYNTHETIC_TX_ID}/void`,
        payload: {},
      });
      expect(inj.statusCode).toBe(401);
    });

    it('GET /v1/transactions/:id/receipt sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${SYNTHETIC_TX_ID}/receipt`,
      });
      expect(inj.statusCode).toBe(401);
    });

    it('GET /v1/reconciliation sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'GET',
        url: '/v1/reconciliation?startDate=2026-01-01&endDate=2026-01-15',
      });
      expect(inj.statusCode).toBe(401);
    });

    it('POST /v1/reconciliation/jobs sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'POST',
        url: '/v1/reconciliation/jobs',
        payload: { startDate: '2026-01-01', endDate: '2026-01-15' },
      });
      expect(inj.statusCode).toBe(401);
    });

    it('GET /v1/reconciliation/jobs/:jobId sem Authorization -> 401', async () => {
      const inj = await app.inject({
        method: 'GET',
        url: `/v1/reconciliation/jobs/${RANDOM_JOB_ID}`,
      });
      expect(inj.statusCode).toBe(401);
    });
  });

  // 2) JWT valido sem `transactions:void` -> 403
  it('POST void sem scope transactions:void -> 403 SCOPE_MISSING', async () => {
    await seedTransactionReal({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      status: TransactionStatus.APPROVED,
    });
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      operatorId: 'op-1',
      scopes: ['transactions:read', 'reconciliation:read'],
      accountStatus: 'ACTIVE',
    });
    const inj = await app.inject({
      method: 'POST',
      url: `/v1/transactions/${SYNTHETIC_TX_ID}/void`,
      headers: { authorization: bearer(token) },
      payload: {},
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('SCOPE_MISSING');
  });

  // 3) GET /v1/reconciliation sem `reconciliation:read` -> 403
  it('GET /v1/reconciliation sem scope reconciliation:read -> 403', async () => {
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      scopes: ['transactions:read'],
      accountStatus: 'ACTIVE',
    });
    const inj = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation?startDate=2026-01-01&endDate=2026-01-15',
      headers: { authorization: bearer(token) },
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('SCOPE_MISSING');
  });

  it('POST /v1/reconciliation/jobs sem scope reconciliation:read -> 403', async () => {
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      scopes: ['transactions:read', 'transactions:void'],
      accountStatus: 'ACTIVE',
    });
    const inj = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/jobs',
      headers: { authorization: bearer(token) },
      payload: { startDate: '2026-01-01', endDate: '2026-01-15' },
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('SCOPE_MISSING');
  });

  // 4) SUSPENDED -> 403 ACCOUNT_SUSPENDED
  it('SUSPENDED -> 403 ACCOUNT_SUSPENDED no GET /v1/transactions', async () => {
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      scopes: fullScopes,
      accountStatus: 'SUSPENDED',
    });
    const inj = await app.inject({
      method: 'GET',
      url: '/v1/transactions',
      headers: { authorization: bearer(token) },
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string; reason?: string } };
    expect(body.error?.code).toBe('ACCOUNT_SUSPENDED');
    expect(typeof body.error?.reason).toBe('string');
  });

  it('SUSPENDED -> 403 tambem no GET /v1/reconciliation', async () => {
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      scopes: fullScopes,
      accountStatus: 'SUSPENDED',
    });
    const inj = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation?startDate=2026-01-01&endDate=2026-01-15',
      headers: { authorization: bearer(token) },
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('ACCOUNT_SUSPENDED');
  });

  // 5) INACTIVE -> 403 ACCOUNT_INACTIVE
  it('INACTIVE -> 403 ACCOUNT_INACTIVE no GET /v1/transactions', async () => {
    const token = signTestJwt({
      merchantId: MERCHANT_A_ID,
      terminalId: merchantATerminalId,
      scopes: fullScopes,
      accountStatus: 'INACTIVE',
    });
    const inj = await app.inject({
      method: 'GET',
      url: '/v1/transactions',
      headers: { authorization: bearer(token) },
    });
    expect(inj.statusCode).toBe(403);
    const body = inj.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('ACCOUNT_INACTIVE');
  });

  // 6) Cross-tenant isolation
  describe('cross-tenant isolation', () => {
    let txAId: string;

    beforeEach(async () => {
      const seeded = await seedTransactionReal({
        merchantId: MERCHANT_A_ID,
        terminalId: merchantATerminalId,
        status: TransactionStatus.APPROVED,
        amount: 1500,
        currency: 'USD',
        authorizationCode: 'AUTH-A1',
        acquirerReferenceNumber: 'ARN-A1',
      });
      txAId = seeded.id;
    });

    it('merchantB GET /v1/transactions/:id (id pertence a A) -> 404', async () => {
      const tokenB = signTestJwt({
        merchantId: MERCHANT_B_ID,
        scopes: fullScopes,
        accountStatus: 'ACTIVE',
      });
      const inj = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${txAId}`,
        headers: { authorization: bearer(tokenB) },
      });
      expect(inj.statusCode).toBe(404);
      const body = inj.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('merchantB POST /v1/transactions/:id/void (id pertence a A) -> 404', async () => {
      const tokenB = signTestJwt({
        merchantId: MERCHANT_B_ID,
        operatorId: 'op-b',
        scopes: fullScopes,
        accountStatus: 'ACTIVE',
      });
      const inj = await app.inject({
        method: 'POST',
        url: `/v1/transactions/${txAId}/void`,
        headers: { authorization: bearer(tokenB) },
        payload: {},
      });
      expect(inj.statusCode).toBe(404);
      const body = inj.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('merchantB GET /v1/transactions nao retorna a tx-A1', async () => {
      const tokenB = signTestJwt({
        merchantId: MERCHANT_B_ID,
        scopes: fullScopes,
        accountStatus: 'ACTIVE',
      });
      const inj = await app.inject({
        method: 'GET',
        url: '/v1/transactions',
        headers: { authorization: bearer(tokenB) },
      });
      expect(inj.statusCode).toBe(200);
      const body = inj.json() as {
        items: ReadonlyArray<{ id: string; merchantId: string }>;
        total: number;
      };
      expect(body.items.find((it) => it.id === txAId)).toBeUndefined();
      for (const item of body.items) {
        expect(item.merchantId).toBe(MERCHANT_B_ID);
      }
    });
  });
});
