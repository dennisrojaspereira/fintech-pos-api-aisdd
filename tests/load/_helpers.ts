/**
 * Shared helpers for load tests (Onda 6 — Tasks 17.1 e 17.2*).
 *
 * Estes helpers preparam o ambiente "real" minimo para os scripts em
 * `tests/load/*.ts`:
 *
 *   - `setupLoadEnv()` injeta a chave publica RS256 e carrega `.env.test`.
 *     Chame ANTES de `loadEnv()` (do src/config/env.js) para que a env
 *     validada pelo zod use o keypair do `tests/setup/jwt.ts`.
 *
 *   - `startAcquirerStub({ delayMs })` sobe um servidor HTTP cru (sem
 *     Fastify, sem deps adicionais) que responde com
 *     `{ outcome: 'APPROVED', authorizationCode, acquirerReferenceNumber, responseCode }`
 *     em formato JSON apos `delayMs` (default 1000 ms — req 1.1 dos
 *     load tests). Retorna `{ baseUrl, close }`.
 *
 *   - `startServerForLoad()` sobe o Fastify do `buildServer` em uma
 *     porta livre (HOST=127.0.0.1, PORT=0 vindos do `.env.test`).
 *
 *   - `seedSingleMerchant()` injeta um Merchant ACTIVE + Terminal e
 *     retorna seus ids.
 *
 *   - `formatPercentile()` formata um numero (ms) com 2 casas.
 *
 * Reqs alvo: 1.1, 5.5.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { injectTestPublicKey } from '../setup/jwt.js';
import { seedMerchantReal, type SeededMerchantReal } from '../setup/db.js';

// ─────────────────────────────────────────────
// Env bootstrap — DEVE ser chamado antes de `loadEnv()`.
// ─────────────────────────────────────────────

/**
 * Injeta JWT_PUBLIC_KEY do keypair de teste e carrega `.env.test`.
 * Idempotente.
 */
export async function setupLoadEnv(): Promise<void> {
  injectTestPublicKey();
  // Import dinamico para nao sobrescrever envs ja setadas no processo.
  await import('../setup/env.js');
}

// ─────────────────────────────────────────────
// Acquirer stub
// ─────────────────────────────────────────────

export interface AcquirerStubOptions {
  /** Delay artificial antes de responder. Default: 1000 ms (req 17.1). */
  readonly delayMs?: number;
  /** Outcome a forcar. Default: 'APPROVED'. */
  readonly outcome?: 'APPROVED' | 'DECLINED' | 'TIMEOUT';
}

export interface AcquirerStubHandle {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Sobe um stub HTTP minimo (node:http) que aceita POST /authorizations
 * e POST /voids respondendo em `delayMs` com payload compatibilizado
 * ao parser do `acquirer-client.ts`.
 *
 * NAO usa Fastify para nao introduzir uma camada extra de logging e
 * permitir overhead minimo. Aceita conexoes em 127.0.0.1 numa porta
 * livre (port=0).
 */
export async function startAcquirerStub(
  opts: AcquirerStubOptions = {},
): Promise<AcquirerStubHandle> {
  const delayMs = opts.delayMs ?? 1000;
  const outcome = opts.outcome ?? 'APPROVED';

  const handler = (_req: IncomingMessage, res: ServerResponse): void => {
    setTimeout(() => {
      const body =
        outcome === 'APPROVED'
          ? {
              outcome: 'APPROVED',
              authorizationCode: 'STUB-AUTH',
              acquirerReferenceNumber: 'STUB-ARN',
              declineCode: null,
              responseCode: '200',
            }
          : outcome === 'DECLINED'
            ? {
                outcome: 'DECLINED',
                authorizationCode: null,
                acquirerReferenceNumber: null,
                declineCode: 'INSUFFICIENT_FUNDS',
                responseCode: '402',
              }
            : {
                outcome: 'TIMEOUT',
                authorizationCode: null,
                acquirerReferenceNumber: null,
                declineCode: null,
                responseCode: null,
              };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    }, delayMs);
  };

  const server: Server = createServer((req, res) => {
    // Drena o body sem usar — nao precisamos parsear no stub.
    req.on('data', () => {
      /* discard */
    });
    req.on('end', () => handler(req, res));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      }),
  };
}

// ─────────────────────────────────────────────
// Fastify server boot
// ─────────────────────────────────────────────

/**
 * Sobe o servidor Fastify real em uma porta livre (127.0.0.1:0).
 * Retorna `{ app, baseUrl }`. O caller e responsavel por `app.close()`.
 */
export async function startServerForLoad(): Promise<{
  readonly app: import('fastify').FastifyInstance;
  readonly baseUrl: string;
}> {
  const { buildServer } = await import('../../src/server.js');
  const { loadEnv } = await import('../../src/config/env.js');

  const env = loadEnv();
  const app = await buildServer({ env });
  // Listen 0.0.0.0:0 ja vem do env (HOST=127.0.0.1, PORT=0 em .env.test).
  await app.listen({ host: env.HOST, port: env.PORT });
  // Em Fastify, app.server.address() devolve { port } apos listen().
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('startServerForLoad: failed to resolve listening address');
  }
  const baseUrl = `http://${addr.address}:${addr.port}`;
  return { app, baseUrl };
}

// ─────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────

/**
 * Limpa banco/redis (via helpers do W5-B) e cria 1 Merchant ACTIVE
 * com 1 Terminal. Retorna o seed para uso no body do JWT.
 */
export async function seedSingleMerchant(): Promise<SeededMerchantReal> {
  const { cleanDatabaseReal, flushRedisReal } = await import('../setup/db.js');
  await cleanDatabaseReal();
  await flushRedisReal();
  return seedMerchantReal({ name: 'Load Test Merchant' });
}

// ─────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────

export function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

export function ok(label: string, ms: number, threshold: number): boolean {
  const passed = ms <= threshold;
  // eslint-disable-next-line no-console
  console.log(
    `${passed ? '[PASS]' : '[FAIL]'} ${label}: ${formatMs(ms)} (threshold ${formatMs(threshold)})`,
  );
  return passed;
}
