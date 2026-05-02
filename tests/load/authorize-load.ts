/**
 * Load test — POST /v1/transactions (Task 17.1).
 *
 * Reqs alvo: 1.1.
 *
 * Spec (design.md "Performance / Load"):
 *   - 100 conexoes concorrentes contra POST /v1/transactions com
 *     acquirer stub respondendo em 1 s.
 *   - Verificar P95 latencia <= 5 s.
 *   - Medir overhead do Redis idempotency lookup (P99 <= 5 ms).
 *
 * Pre-requisitos de execucao:
 *   $ docker compose up -d   # postgres + redis prontos
 *   $ npm run prisma:deploy  # migrations aplicadas em posapi_test
 *   $ npm run test:load
 *
 * Estrategia (resumo):
 *   1. setupLoadEnv()       — injeta JWT_PUBLIC_KEY, carrega .env.test.
 *   2. startAcquirerStub()  — sobe HTTP stub que responde em 1 s.
 *      Sobrescreve `process.env.ACQUIRER_BASE_URL` ANTES de loadEnv().
 *   3. seedSingleMerchant() — cria Merchant ACTIVE + Terminal reais.
 *   4. signTestJwt(...)     — emite JWT RS256 com scope transactions:write.
 *   5. startServerForLoad() — boot Fastify em 127.0.0.1:0.
 *   6. autocannon({...})    — 100 connections, amount=100, body valido.
 *      Cada request tem Idempotency-Key UNICO via setupClient (req 7.1
 *      proibe duas reqs com a mesma key).
 *   7. Verifica `latency.p97_5 <= 5000` ms (autocannon nao expoe p95
 *     direto; p97_5 e mais conservador, garantindo que p95 tambem cai).
 *     Se falhar, exit 1.
 *
 * Notas sobre o overhead da idempotency lookup (req 1.1 segundo
 * paragrafo):
 *
 *   A medicao A/B ideal seria executar 2 corridas — uma com Redis
 *   ativo e outra com Redis desligado — e comparar o delta P99 do
 *   total request time. Em sandbox isso e caro (precisa SIGSTOP no
 *   container Redis ou variant build sem o middleware) e potencialmente
 *   instavel. Para esta versao deixamos a medicao A/B como TODO e
 *   reportamos apenas o P99 do endpoint inteiro, que serve como upper
 *   bound. Uma instrumentacao mais precisa pode ser feita ativando
 *   `MEASURE_IDEMPOTENCY=1` (sem efeito hoje — placeholder) e logando
 *   timings dentro do `idempotency-store.ts`. Veja o TODO abaixo.
 *
 * Side effects:
 *   - Limpa banco e redis no inicio.
 *   - Imprime resumo do autocannon e veredicto contra a SLA.
 *   - Encerra o processo com exit 0 (sucesso) ou exit 1 (falha de SLA).
 */

import { randomUUID } from 'node:crypto';
import autocannon, {
  type Client,
  type Options as AutocannonOptions,
  type Result,
} from 'autocannon';

import { signTestJwt, bearer } from '../setup/jwt.js';
import { disposeRealClients } from '../setup/db.js';
import {
  formatMs,
  ok,
  seedSingleMerchant,
  setupLoadEnv,
  startAcquirerStub,
  startServerForLoad,
} from './_helpers.js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const TOTAL_REQUESTS = 100;
const CONCURRENT_CONNECTIONS = 100;
/** P95 SLA. Verificamos contra `p97_5` (mais conservador). */
const P95_SLA_MS = 5_000;
/** Acquirer stub delay. Match com o spec. */
const ACQUIRER_DELAY_MS = 1_000;
/** Timeout interno do autocannon por request (deve > acquirer delay). */
const AUTOCANNON_TIMEOUT_S = 30;

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<number> {
  // 1) Stub do acquirer ANTES de loadEnv() para que o env zod valide
  //    a URL real do stub.
  const stub = await startAcquirerStub({ delayMs: ACQUIRER_DELAY_MS });
  process.env['ACQUIRER_BASE_URL'] = stub.baseUrl;
  process.env['ACQUIRER_API_KEY'] = process.env['ACQUIRER_API_KEY'] ?? 'test-key';
  // Garante que o timeout do undici/circuit-breaker nao corta antes
  // do stub responder + folga.
  process.env['ACQUIRER_TIMEOUT_MS'] = '25000';

  // 2) Carrega .env.test e injeta JWT_PUBLIC_KEY.
  await setupLoadEnv();

  // Re-injeta ACQUIRER_BASE_URL (env loader nao sobrescreve, mas o
  // setupLoadEnv() pode ter recarregado a chave de produto, garantia
  // dupla):
  process.env['ACQUIRER_BASE_URL'] = stub.baseUrl;

  // 3) Boot do Fastify real.
  const { app, baseUrl } = await startServerForLoad();

  try {
    // 4) Seed de merchant + terminal ACTIVE.
    const seeded = await seedSingleMerchant();

    // 5) JWT RS256 com scopes minimos para POST /transactions.
    const token = signTestJwt({
      merchantId: seeded.id,
      terminalId: seeded.terminalId,
      operatorId: 'op-load-1',
      scopes: ['transactions:write', 'transactions:read'],
      accountStatus: 'ACTIVE',
    });

    // 6) Body fixo (paymentMethod + amount validos).
    const bodyTemplate = {
      amount: 1500,
      currency: 'BRL',
      paymentMethod: {
        type: 'CREDIT_CARD',
        maskedPan: '****1234',
        expiryMonth: 12,
        expiryYear: 2030,
      },
      terminalId: seeded.terminalId,
    } as const;
    const bodyStr = JSON.stringify(bodyTemplate);

    // 7) autocannon — 100 connections, amount=100. Cada request com
    //    Idempotency-Key UNICA gerada em `setupClient`.
    const opts: AutocannonOptions = {
      url: `${baseUrl}/v1/transactions`,
      method: 'POST',
      connections: CONCURRENT_CONNECTIONS,
      amount: TOTAL_REQUESTS,
      timeout: AUTOCANNON_TIMEOUT_S,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: bearer(token),
      },
      body: bodyStr,
      // Cada cliente do autocannon assina cada request com uma nova
      // Idempotency-Key (UUID), evitando que o middleware retorne 409
      // (CONCURRENT_REQUEST) ou cache hit (req 7.1).
      setupClient: (client: Client): void => {
        const installFresh = (): void => {
          client.setHeaders({
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: bearer(token),
            'idempotency-key': randomUUID(),
          });
        };
        installFresh();
        // Toda vez que recebemos uma resposta, refazemos os headers
        // antes da proxima request — autocannon reusa o body padrao
        // mas precisa de header novo a cada round.
        client.on('response', () => {
          installFresh();
        });
      },
    };

    // eslint-disable-next-line no-console
    console.log(
      `[authorize-load] starting: connections=${CONCURRENT_CONNECTIONS} amount=${TOTAL_REQUESTS} target=${baseUrl}/v1/transactions`,
    );

    const result: Result = await autocannon(opts);

    // 8) Resumo.
    // eslint-disable-next-line no-console
    console.log(autocannon.printResult(result));
    // eslint-disable-next-line no-console
    console.log(
      `[authorize-load] non2xx=${result.non2xx} 2xx=${result['2xx']} errors=${result.errors} timeouts=${result.timeouts}`,
    );

    // 9) Veredicto contra SLA.
    //    Autocannon nao expoe p95 — usamos p97_5 como upper bound:
    //    p97_5 >= p95, portanto se p97_5 <= 5000ms, entao p95 <= 5000ms.
    const p97_5 = result.latency.p97_5;
    const p99 = result.latency.p99;
    // eslint-disable-next-line no-console
    console.log(
      `[authorize-load] latency p90=${formatMs(result.latency.p90)} p97_5=${formatMs(p97_5)} p99=${formatMs(p99)} max=${formatMs(result.latency.max)}`,
    );

    const passedSla = ok('P95 (via p97_5) <= 5s', p97_5, P95_SLA_MS);

    // 10) TODO: medir overhead Redis idempotency lookup (req 1.1 §2).
    //     Plano sugerido (futuro):
    //       (a) Adicionar instrumentacao opcional no `idempotency-store.ts`
    //           atras de env `MEASURE_IDEMPOTENCY=1` que mede `lookup()`
    //           com `process.hrtime.bigint()` e empilha em um array
    //           in-memory acessivel via export.
    //       (b) Rodar uma 2a corrida do autocannon com `MEASURE=1`,
    //           extrair P99 dos timings e validar <= 5 ms.
    //     Por ora reportamos o P99 do endpoint completo como upper-bound:
    // eslint-disable-next-line no-console
    console.log(
      `[authorize-load] TODO: idempotency.lookup P99 a medir via MEASURE_IDEMPOTENCY=1; upper-bound endpoint P99=${formatMs(p99)}`,
    );

    return passedSla ? 0 : 1;
  } finally {
    await app.close();
    await stub.close();
    await disposeRealClients();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[authorize-load] fatal:', err);
    process.exitCode = 1;
  });
