/**
 * Load test — Reconciliation thresholds (Task 17.2*).
 *
 * Reqs alvo: 5.5.
 *
 * Spec (design.md "Performance / Load"):
 *   - GET /v1/reconciliation com 10.000 records concluido <= 3 s (sync).
 *   - Apos passar do threshold, POST /v1/reconciliation/jobs deve
 *     despachar e responder em <= 500 ms (async).
 *
 * Asterisco no nome (17.2*) indica prioridade menor — este script e
 * opcional na suite de validacao final.
 *
 * Pre-requisitos:
 *   $ docker compose up -d
 *   $ npm run prisma:deploy
 *   $ npm run test:load:reconciliation
 *
 * Estrategia:
 *   1. setupLoadEnv() + seed Merchant/Terminal.
 *   2. Aumenta `RECONCILIATION_ASYNC_THRESHOLD` para 10_000 (default
 *      do `.env.test` = 100, o que faria a 1a requisicao cair no path
 *      assincrono. Para validar a faixa sincrona em 10k records
 *      sobrescrevemos antes de loadEnv()).
 *   3. Insere 10_000 transacoes APPROVED via prisma.transaction.createMany
 *      em chunks de 1000 — evita exceder o limite de bind parameters
 *      do Postgres.
 *   4. Boot Fastify; emite JWT com scope reconciliation:read.
 *   5. SYNC: 1 chamada GET /v1/reconciliation cobrindo o range.
 *      Mede com `process.hrtime.bigint()` e valida <= 3 s.
 *   6. ASYNC: insere mais 1 record, depois faz POST /reconciliation/jobs
 *      (com threshold reduzido para 10_000 antes da request async).
 *      Mede e valida <= 500 ms.
 *
 * NOTA sobre threshold: a forma simples de testar o async path e
 * baixar `RECONCILIATION_ASYNC_THRESHOLD` para algo abaixo do
 * count atual via env e reabrir o app. Como reload de env apos
 * loadEnv() exigiria limpar o cache, optamos pela alternativa de
 * setar threshold = 10_000 desde o inicio e inserir 10_001 records
 * antes da chamada async.
 *
 * Side effects:
 *   - Limpa banco e Redis no inicio.
 *   - Imprime tempos e veredicto. exit 0 = sucesso, exit 1 = falha SLA.
 */

import { PaymentMethodType, TransactionStatus } from '../../src/shared/enums.js';
import { signTestJwt, bearer } from '../setup/jwt.js';
import {
  cleanDatabaseReal,
  disposeRealClients,
  flushRedisReal,
  getPrisma,
  seedMerchantReal,
} from '../setup/db.js';
import { formatMs, ok, setupLoadEnv, startServerForLoad } from './_helpers.js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const SYNC_TARGET_COUNT = 10_000;
const SYNC_SLA_MS = 3_000;
const ASYNC_SLA_MS = 500;
const CHUNK_SIZE = 1_000;

const RANGE_START = '2026-01-01';
const RANGE_END = '2026-01-31';

// ─────────────────────────────────────────────
// Helpers locais
// ─────────────────────────────────────────────

async function insertApprovedTransactions(
  merchantId: string,
  terminalId: string,
  count: number,
): Promise<void> {
  const prisma = getPrisma();
  // Distribui as datas dentro do range do reconciliation (2026-01-01 a
  // 2026-01-31) para garantir matches pela query.
  const startMs = new Date(`${RANGE_START}T00:00:00Z`).getTime();
  const endMs = new Date(`${RANGE_END}T23:59:59Z`).getTime();
  const span = endMs - startMs;

  let inserted = 0;
  while (inserted < count) {
    const batch = Math.min(CHUNK_SIZE, count - inserted);
    const rows = Array.from({ length: batch }, (_v, i) => {
      const idx = inserted + i;
      const createdAt = new Date(startMs + (span * idx) / count);
      return {
        merchantId,
        terminalId,
        amount: 1000 + (idx % 100),
        currency: 'BRL',
        paymentMethodType: PaymentMethodType.CREDIT_CARD,
        maskedPan: '****1234',
        status: TransactionStatus.APPROVED,
        authorizationCode: `AUTH-${idx}`,
        acquirerReferenceNumber: `ARN-${idx}`,
        settlementStatus: 'PENDING_SETTLEMENT' as const,
        createdAt,
        updatedAt: createdAt,
      };
    });
    await prisma.transaction.createMany({ data: rows, skipDuplicates: true });
    inserted += batch;
  }
}

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
}

async function httpGet(baseUrl: string, path: string, token: string): Promise<InjectResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { authorization: bearer(token), accept: 'application/json' },
  });
  return { statusCode: res.status, body: await res.text() };
}

async function httpPost(
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
): Promise<InjectResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: bearer(token),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { statusCode: res.status, body: await res.text() };
}

function elapsedMs(startNs: bigint): number {
  const diff = process.hrtime.bigint() - startNs;
  return Number(diff) / 1e6;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<number> {
  // 1) Garante threshold = 10_000 ANTES de loadEnv() (default do
  //    .env.test e 100 — abaixo do nosso seed; precisamos elevar).
  process.env['RECONCILIATION_ASYNC_THRESHOLD'] = String(SYNC_TARGET_COUNT);
  // ACQUIRER_BASE_URL e obrigatorio na env zod, mesmo que aqui nao
  // chamemos o acquirer. Setamos um placeholder valido se ausente.
  process.env['ACQUIRER_BASE_URL'] =
    process.env['ACQUIRER_BASE_URL'] ?? 'http://127.0.0.1:9999';
  process.env['ACQUIRER_API_KEY'] = process.env['ACQUIRER_API_KEY'] ?? 'test-key';

  await setupLoadEnv();
  // Re-confirma threshold caso o loader tenha sobrescrito (nao
  // sobrescreve, mas defensivo):
  process.env['RECONCILIATION_ASYNC_THRESHOLD'] = String(SYNC_TARGET_COUNT);

  const { app, baseUrl } = await startServerForLoad();

  try {
    // 2) Seed limpo + Merchant.
    await cleanDatabaseReal();
    await flushRedisReal();
    const seeded = await seedMerchantReal({ name: 'Recon Load Merchant' });

    // 3) Insere 10_000 transacoes APPROVED.
    // eslint-disable-next-line no-console
    console.log(
      `[reconciliation-load] inserting ${SYNC_TARGET_COUNT} APPROVED transactions in chunks of ${CHUNK_SIZE}...`,
    );
    const seedStart = process.hrtime.bigint();
    await insertApprovedTransactions(seeded.id, seeded.terminalId, SYNC_TARGET_COUNT);
    // eslint-disable-next-line no-console
    console.log(
      `[reconciliation-load] seed done in ${formatMs(elapsedMs(seedStart))}`,
    );

    // 4) JWT com scope reconciliation:read.
    const token = signTestJwt({
      merchantId: seeded.id,
      terminalId: seeded.terminalId,
      operatorId: 'op-recon-load',
      scopes: ['reconciliation:read'],
      accountStatus: 'ACTIVE',
    });

    // 5) Sync path — GET /v1/reconciliation.
    // eslint-disable-next-line no-console
    console.log('[reconciliation-load] running SYNC measurement...');
    const syncStart = process.hrtime.bigint();
    const syncRes = await httpGet(
      baseUrl,
      `/v1/reconciliation?startDate=${RANGE_START}&endDate=${RANGE_END}&terminalId=${encodeURIComponent(
        seeded.terminalId,
      )}`,
      token,
    );
    const syncMs = elapsedMs(syncStart);
    if (syncRes.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error(
        `[reconciliation-load] SYNC unexpected status=${syncRes.statusCode} body=${syncRes.body.slice(0, 500)}`,
      );
      return 1;
    }
    const syncOk = ok(`SYNC reconciliation 10k records <= 3s`, syncMs, SYNC_SLA_MS);

    // 6) Async path — adicionamos +1 transacao para empurrar o
    //    estimated count para 10_001 (acima do threshold setado para
    //    10_000) e disparamos POST /v1/reconciliation/jobs.
    await insertApprovedTransactions(seeded.id, seeded.terminalId, 1);

    // eslint-disable-next-line no-console
    console.log('[reconciliation-load] running ASYNC dispatch measurement...');
    const asyncStart = process.hrtime.bigint();
    const asyncRes = await httpPost(
      baseUrl,
      '/v1/reconciliation/jobs',
      token,
      {
        startDate: RANGE_START,
        endDate: RANGE_END,
        terminalId: seeded.terminalId,
      },
    );
    const asyncMs = elapsedMs(asyncStart);
    if (asyncRes.statusCode !== 201 && asyncRes.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error(
        `[reconciliation-load] ASYNC unexpected status=${asyncRes.statusCode} body=${asyncRes.body.slice(0, 500)}`,
      );
      return 1;
    }
    const asyncOk = ok('ASYNC dispatch <= 500ms', asyncMs, ASYNC_SLA_MS);

    // eslint-disable-next-line no-console
    console.log(
      `[reconciliation-load] summary: sync=${formatMs(syncMs)} async=${formatMs(asyncMs)}`,
    );

    return syncOk && asyncOk ? 0 : 1;
  } finally {
    await app.close();
    await disposeRealClients();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[reconciliation-load] fatal:', err);
    process.exitCode = 1;
  });
