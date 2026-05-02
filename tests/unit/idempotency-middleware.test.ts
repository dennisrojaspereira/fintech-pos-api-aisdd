/**
 * Unit tests — Idempotency Middleware (Task 15.3).
 *
 * Requirements: 7.1, 7.2, 7.4 (+ 1.6 safe-mode).
 *
 * Cobertura:
 *   1. Cache hit retorna replay header `Idempotent-Replayed: true` e
 *      reusa o `httpStatus` armazenado, sem invocar o handler downstream.
 *   2. Lock contention (`acquireLock` -> ok(null)) retorna 409
 *      `CONCURRENT_REQUEST` e o handler downstream NAO e chamado.
 *   3. Expired key = miss: handler downstream e chamado e a resposta e
 *      persistida via `store(key, response)` no onSend.
 *
 * Estrategia:
 *   - Fastify in-memory + `app.inject(...)`.
 *   - `IdempotencyStore` mockado via `vi.fn()` e injetado em
 *     `buildIdempotencyPreHandler(mockStore)` e nos hooks
 *     `onSend`/`onResponse` simulados localmente (sem registrar plugin
 *     completo — testamos a unidade preHandler com escopo minimo).
 *   - Para o caso de miss + persistencia, usamos `registerIdempotencyForRoute`
 *     que prende preHandler + onSend + onResponse na rota POST /transactions.
 */

import './../setup/env.js';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildIdempotencyPreHandler,
  registerIdempotencyForRoute,
} from '../../src/infra/http/middleware/idempotency.js';
import type {
  IdempotencyStore,
  Lock,
} from '../../src/infra/cache/idempotency-store.js';
import { ok } from '../../src/shared/result.js';
import type { SerializedResponse } from '../../src/shared/types.js';

/**
 * Constroi um IdempotencyStore mockado preenchendo apenas as 4 funcoes
 * publicas usadas pelo middleware. Usamos `unknown as IdempotencyStore`
 * porque a classe tem campos privados (redis, redlock) que nao queremos
 * inicializar nos testes.
 */
interface MockedStore {
  lookup: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  acquireLock: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
}

function buildMockStore(overrides: Partial<MockedStore> = {}): {
  store: IdempotencyStore;
  spies: MockedStore;
} {
  const lock: Lock = {
    release: vi.fn().mockResolvedValue(undefined),
  };
  const spies: MockedStore = {
    lookup: vi.fn().mockResolvedValue(ok(null)),
    store: vi.fn().mockResolvedValue(ok(undefined)),
    acquireLock: vi.fn().mockResolvedValue(ok(lock)),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    store: spies as unknown as IdempotencyStore,
    spies,
  };
}

describe('Idempotency Middleware (Task 15.3 — Reqs 7.1, 7.2, 7.4)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('cache HIT: replays cached response with Idempotent-Replayed: true and skips handler', async () => {
    const cached: SerializedResponse = {
      httpStatus: 201,
      body: JSON.stringify({ transactionId: 'tx_cached', status: 'APPROVED' }),
      headers: {
        'content-type': 'application/json',
        'x-trace-id': 'cached-trace',
      },
    };
    const { store, spies } = buildMockStore({
      lookup: vi.fn().mockResolvedValue(ok(cached)),
    });
    const downstreamHandler = vi.fn(async () => ({ untouched: true }));

    const preHandler = buildIdempotencyPreHandler(store);
    app.post('/transactions', { preHandler }, downstreamHandler);

    const response = await app.inject({
      method: 'POST',
      url: '/transactions',
      headers: { 'idempotency-key': 'k-hit' },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotent-replayed']).toBe('true');
    expect(response.body).toBe(cached.body);
    expect(downstreamHandler).not.toHaveBeenCalled();
    expect(spies.lookup).toHaveBeenCalledWith('k-hit');
    // O lock e adquirido e liberado mesmo no caminho de hit.
    expect(spies.acquireLock).toHaveBeenCalledWith('k-hit');
    expect(spies.releaseLock).toHaveBeenCalled();
    // Nao chamamos store(...) em replay — apenas lookup.
    expect(spies.store).not.toHaveBeenCalled();
  });

  it('lock contention: returns 409 CONCURRENT_REQUEST and skips handler', async () => {
    const { store, spies } = buildMockStore({
      // Sucesso ao tentar adquirir, mas o valor e null = contention (req 7.2).
      acquireLock: vi.fn().mockResolvedValue(ok(null)),
    });
    const downstreamHandler = vi.fn(async () => ({ untouched: true }));

    const preHandler = buildIdempotencyPreHandler(store);
    app.post('/transactions', { preHandler }, downstreamHandler);

    const response = await app.inject({
      method: 'POST',
      url: '/transactions',
      headers: { 'idempotency-key': 'k-busy' },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('CONCURRENT_REQUEST');
    expect(downstreamHandler).not.toHaveBeenCalled();
    // Nem lookup nem store sao consultados quando o lock falha por contention.
    expect(spies.lookup).not.toHaveBeenCalled();
    expect(spies.store).not.toHaveBeenCalled();
  });

  it('expired key (miss): downstream runs and onSend persists response via store(key, ...)', async () => {
    // Para validar persist precisamos do plugin completo (preHandler + onSend
    // + onResponse) prendido apenas em POST /transactions.
    const { store, spies } = buildMockStore({
      // lookup retorna null = chave expirada / nao existe (req 7.4 implica
      // que apos TTL a request original e re-executada).
      lookup: vi.fn().mockResolvedValue(ok(null)),
    });
    const downstreamPayload = {
      transactionId: 'tx_new',
      status: 'APPROVED' as const,
    };
    const downstreamHandler = vi.fn(async () => downstreamPayload);

    registerIdempotencyForRoute(app, store);
    app.post('/transactions', downstreamHandler);

    const response = await app.inject({
      method: 'POST',
      url: '/transactions',
      headers: { 'idempotency-key': 'k-fresh' },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(200);
    expect(downstreamHandler).toHaveBeenCalledTimes(1);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(spies.lookup).toHaveBeenCalledWith('k-fresh');
    expect(spies.store).toHaveBeenCalledTimes(1);
    const [persistedKey, persistedResponse] = spies.store.mock.calls[0] as [
      string,
      SerializedResponse,
    ];
    expect(persistedKey).toBe('k-fresh');
    expect(persistedResponse.httpStatus).toBe(200);
    expect(persistedResponse.body).toContain('tx_new');
    // Lock liberado apos a resposta sair.
    expect(spies.releaseLock).toHaveBeenCalled();
  });
});
