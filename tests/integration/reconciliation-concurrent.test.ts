/**
 * Integration tests — Task 16.4 (Reconciliation + Concurrent Idempotency).
 *
 * Cobre requirements 5.1, 5.3, 5.5 e 7.2:
 *   1. GET /v1/reconciliation com range valido: APPROVED + VOIDED + totals.
 *   2. Range > 31 dias → 400 com `code: 'DATE_RANGE_EXCEEDED'`.
 *   3. POST /v1/reconciliation/jobs → cria QUEUED, progride a COMPLETED via
 *      worker BullMQ embarcado (Opcao A).
 *   4. Concurrent idempotency: 2 reqs simultaneas mesma key → 1 sucesso e
 *      1 conflito (409). Apenas 1 row em `prisma.transaction`.
 *
 * Decisao sobre worker:
 *   - **Opcao A**: inicializamos `createReconciliationWorker` localmente.
 *
 * Estrategia:
 *   - Reusa helpers do W5-B em `tests/setup/jwt.ts` e `tests/setup/db.ts`.
 *   - Stub do AcquirerAdapter via vi.mock para forcar APPROVED.
 */

import { injectTestPublicKey, signTestJwt, bearer } from '../setup/jwt.js';
injectTestPublicKey();

import '../setup/env.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  Worker,
  type Job,
  type ConnectionOptions,
  type Processor,
} from 'bullmq';

import type { Result } from '../../src/shared/result.js';
import type {
  AcquirerAdapterError,
  AcquirerAuthRequest,
  AcquirerResult,
  AcquirerVoidRequest,
} from '../../src/shared/types.js';

vi.mock('../../src/infra/acquirer/acquirer-adapter.js', () => {
  const stub = {
    authorize: vi.fn(
      async (
        _req: AcquirerAuthRequest,
      ): Promise<Result<AcquirerResult, AcquirerAdapterError>> => ({
        ok: true,
        value: {
          outcome: 'APPROVED',
          authorizationCode: 'AUTH-CONC',
          acquirerReferenceNumber: 'ARN-CONC',
          declineCode: null,
          rawResponseCode: '200',
        },
      }),
    ),
    void: vi.fn(
      async (
        _req: AcquirerVoidRequest,
      ): Promise<Result<AcquirerResult, AcquirerAdapterError>> => ({
        ok: true,
        value: {
          outcome: 'APPROVED',
          authorizationCode: null,
          acquirerReferenceNumber: null,
          declineCode: null,
          rawResponseCode: '200',
        },
      }),
    ),
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

import { buildServer } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import {
  PaymentMethodType,
  ReconciliationJobStatus,
  TransactionStatus,
} from '../../src/shared/enums.js';
import {
  createReconciliationWorker,
} from '../../src/infra/queue/reconciliation-queue.js';
import {
  cleanDatabaseReal,
  disposeRealClients,
  flushRedisReal,
  getPrisma,
  seedMerchantReal,
  seedTransactionReal,
} from '../setup/db.js';

const fullScopes: readonly string[] = [
  'transactions:read',
  'transactions:write',
  'transactions:void',
  'reconciliation:read',
];

const RANGE_START = '2026-01-01';
const RANGE_END = '2026-01-31';

let app: FastifyInstance;
let merchantId: string;
let terminalId: string;
let redisUrl: string;

beforeAll(async () => {
  const env = loadEnv();
  redisUrl = env.REDIS_URL;
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
  const seeded = await seedMerchantReal({});
  merchantId = seeded.id;
  terminalId = seeded.terminalId;
});

function authHeader(): string {
  return bearer(
    signTestJwt({
      merchantId,
      terminalId,
      operatorId: 'op-1',
      scopes: fullScopes,
      accountStatus: 'ACTIVE',
    }),
  );
}

describe('Integration — Reconciliation + Concurrent Idempotency (Task 16.4)', () => {
  it('GET /v1/reconciliation retorna apenas APPROVED + VOIDED, com totals', async () => {
    for (let i = 0; i < 5; i++) {
      await seedTransactionReal({
        merchantId,
        terminalId,
        status: TransactionStatus.APPROVED,
        amount: 100,
        paymentMethodType: PaymentMethodType.CREDIT_CARD,
      });
    }
    for (let i = 0; i < 2; i++) {
      await seedTransactionReal({
        merchantId,
        terminalId,
        status: TransactionStatus.VOIDED,
        amount: 200,
        paymentMethodType: PaymentMethodType.DEBIT_CARD,
      });
    }
    for (let i = 0; i < 3; i++) {
      await seedTransactionReal({
        merchantId,
        terminalId,
        status: TransactionStatus.DECLINED,
        amount: 50,
        paymentMethodType: PaymentMethodType.CREDIT_CARD,
      });
    }

    const inj = await app.inject({
      method: 'GET',
      url: `/v1/reconciliation?startDate=${RANGE_START}&endDate=${RANGE_END}&terminalId=${terminalId}`,
      headers: { authorization: authHeader() },
    });

    expect(inj.statusCode).toBe(200);
    const body = inj.json() as {
      records: ReadonlyArray<{
        transactionId: string;
        amount: number;
        paymentMethodType: PaymentMethodType;
      }>;
      totalsByMethod: Record<string, number>;
      generatedAt: string;
    };
    expect(body.records.length).toBe(7);
    expect(body.totalsByMethod['CREDIT_CARD']).toBe(5 * 100);
    expect(body.totalsByMethod['DEBIT_CARD']).toBe(2 * 200);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('GET /v1/reconciliation com range > 31 dias → 400 DATE_RANGE_EXCEEDED', async () => {
    const inj = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation?startDate=2026-01-01&endDate=2026-03-15',
      headers: { authorization: authHeader() },
    });
    expect(inj.statusCode).toBe(400);
    const body = inj.json() as {
      error?: { code?: string; maxDays?: number };
    };
    expect(body.error?.code).toBe('DATE_RANGE_EXCEEDED');
    expect(body.error?.maxDays).toBe(31);
  });

  it('POST /v1/reconciliation/jobs cria QUEUED e progride a COMPLETED', async () => {
    const prisma = getPrisma();
    const connection: ConnectionOptions = { url: redisUrl };
    const processFn: Processor = async (job: Job): Promise<void> => {
      const data = job.data as { jobId: string };
      await prisma.reconciliationJob.update({
        where: { id: data.jobId },
        data: {
          status: ReconciliationJobStatus.COMPLETED,
          resultUrl: `https://storage.example/exports/${data.jobId}.csv`,
        },
      });
    };
    const worker: Worker = createReconciliationWorker(processFn, connection);

    try {
      const post = await app.inject({
        method: 'POST',
        url: '/v1/reconciliation/jobs',
        headers: { authorization: authHeader() },
        payload: { startDate: RANGE_START, endDate: RANGE_END },
      });
      expect(post.statusCode).toBe(201);
      const created = post.json() as {
        jobId: string;
        status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
      };
      expect(created.status).toBe('QUEUED');
      expect(typeof created.jobId).toBe('string');

      let pollStatus = 'QUEUED';
      let resultUrl: string | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const poll = await app.inject({
          method: 'GET',
          url: `/v1/reconciliation/jobs/${created.jobId}`,
          headers: { authorization: authHeader() },
        });
        expect(poll.statusCode).toBe(200);
        const polled = poll.json() as {
          status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
          resultUrl: string | null;
        };
        pollStatus = polled.status;
        resultUrl = polled.resultUrl;
        if (pollStatus === 'COMPLETED' || pollStatus === 'FAILED') break;
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(pollStatus).toBe('COMPLETED');
      expect(typeof resultUrl).toBe('string');
    } finally {
      await worker.close();
    }
  });

  it('Concurrent POST /v1/transactions com mesma Idempotency-Key → 1 sucesso + 1 conflito', async () => {
    const idempotencyKey = `k-concurrent-${Date.now()}`;
    const headers = {
      authorization: authHeader(),
      'idempotency-key': idempotencyKey,
    };
    const payload = {
      amount: 250,
      currency: 'USD',
      paymentMethod: {
        type: 'CREDIT_CARD',
        maskedPan: '****1111',
        expiryMonth: 12,
        expiryYear: 2030,
      },
      terminalId,
    };

    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers,
        payload,
      }),
      app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers,
        payload,
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
    expect(statuses.filter((s) => s === 409).length).toBe(1);
    expect(statuses.filter((s) => s !== 409).length).toBe(1);

    const conflict = resA.statusCode === 409 ? resA : resB;
    const conflictBody = conflict.json() as {
      error?: { code?: string };
    };
    expect(conflictBody.error?.code).toBe('CONCURRENT_REQUEST');

    const prisma = getPrisma();
    const count = await prisma.transaction.count({
      where: { merchantId },
    });
    expect(count).toBeLessThanOrEqual(1);
  });
});
