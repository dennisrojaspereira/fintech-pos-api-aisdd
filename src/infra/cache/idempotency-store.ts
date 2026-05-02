/**
 * Idempotency Store - Redis (ioredis) + Redlock.
 *
 * Source: design.md "Idempotency Store" + "Idempotency Middleware"
 * + requirements 7.1, 7.2, 7.3.
 *
 * Responsabilidades (Task 5.1):
 *   - lookup(key): retorna o SerializedResponse cacheado ou null.
 *   - store(key, response): persiste com SET key value EX 86400 NX
 *     (atomico, anti-overwrite, TTL 24h).
 *   - acquireLock(key): tenta obter um Redlock em lock:{key} TTL 10s.
 *     Retorna null em contention -> middleware traduz para 409 (req 7.2).
 *   - releaseLock(lock): libera; falhas silenciadas (TTL expira sozinho).
 *
 * Em caso de Redis indisponivel, retorna IdempotencyError com code
 * STORE_UNAVAILABLE e httpStatus 503. A decisao de safe-mode fallback
 * e da Task 5.2 (middleware) - aqui apenas reportamos.
 *
 * Tipos (SerializedResponse, IdempotencyError) vem de
 * src/shared/types.ts. NAO redefinir.
 *
 * Requirements: 7.1, 7.2, 7.3.
 */

import { Redis, type Redis as RedisClient } from 'ioredis';
import { createRequire } from 'node:module';

import { loadEnv } from '../../config/env.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  IdempotencyError,
  SerializedResponse,
} from '../../shared/types.js';

// Redlock 5.x's package.json "exports" omite a condicao "types";
// sob NodeNext o resolver TS nao acha as declaracoes. Carregamos via
// createRequire para contornar o resolver de exports e providenciamos
// shapes minimos localmente via interfaces. Em runtime funciona normal.
const require_ = createRequire(import.meta.url);
const RedlockModule: unknown = require_('redlock');

/**
 * Tipo runtime do Lock devolvido pelo Redlock. Shape minimo (release).
 */
export interface Lock {
  release(): Promise<unknown>;
}

interface RedlockLike {
  acquire(resources: string[], duration: number): Promise<Lock>;
  on(event: 'error', handler: (err: unknown) => void): void;
}

interface RedlockCtor {
  new (
    clients: Iterable<RedisClient>,
    settings?: Record<string, unknown>,
  ): RedlockLike;
}

// CJS module pode expor a classe via .default ou direto em exports.
const Redlock: RedlockCtor = ((RedlockModule as { default?: unknown }).default ??
  RedlockModule) as RedlockCtor;

/** TTL do registro de idempotencia em segundos (req 7.3 -> 24h). */
const RECORD_TTL_SECONDS = 86_400;

/** TTL do lock distribuido (Redlock) em milissegundos. */
const LOCK_TTL_MS = 10_000;

/** Prefixo de chave usado pelo lock Redlock. */
const LOCK_PREFIX = 'lock:';

declare global {
  // eslint-disable-next-line no-var
  var __posApiRedisClient: RedisClient | undefined;
  // eslint-disable-next-line no-var
  var __posApiRedlock: RedlockLike | undefined;
}

/**
 * Singleton ioredis. Reutiliza a conexao entre chamadas e entre
 * hot-reloads em desenvolvimento (mesma motivacao do prisma.ts).
 */
export function getRedisClient(): RedisClient {
  if (globalThis.__posApiRedisClient) {
    return globalThis.__posApiRedisClient;
  }
  const env = loadEnv();
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  globalThis.__posApiRedisClient = client;
  return client;
}

/**
 * Singleton Redlock. Single-node (1 cliente) e o setup inicial.
 */
export function getRedlock(): RedlockLike {
  if (globalThis.__posApiRedlock) {
    return globalThis.__posApiRedlock;
  }
  const redlock = new Redlock([getRedisClient()], {
    driftFactor: 0.01,
    retryCount: 0,
    retryDelay: 50,
    retryJitter: 50,
    automaticExtensionThreshold: 500,
  });
  redlock.on('error', () => {
    /* swallow - caller ja recebe Result/null. */
  });
  globalThis.__posApiRedlock = redlock;
  return redlock;
}

export class IdempotencyStore {
  private readonly redis: RedisClient;
  private readonly redlock: RedlockLike;

  public constructor(
    redis: RedisClient = getRedisClient(),
    redlock: RedlockLike = getRedlock(),
  ) {
    this.redis = redis;
    this.redlock = redlock;
  }

  /**
   * Busca uma resposta cacheada. Retorna null em cache miss; retorna
   * STORE_UNAVAILABLE se Redis estiver fora.
   */
  public async lookup(
    key: string,
  ): Promise<Result<SerializedResponse | null, IdempotencyError>> {
    try {
      const raw = await this.redis.get(this.recordKey(key));
      if (raw === null) {
        return ok(null);
      }
      const parsed = JSON.parse(raw) as SerializedResponse;
      return ok(parsed);
    } catch {
      return err({ code: 'STORE_UNAVAILABLE', httpStatus: 503 });
    }
  }

  /**
   * Persiste o response com SET ... EX 86400 NX (atomico, anti-overwrite).
   */
  public async store(
    key: string,
    response: SerializedResponse,
  ): Promise<Result<void, IdempotencyError>> {
    try {
      const payload = JSON.stringify(response);
      await this.redis.set(
        this.recordKey(key),
        payload,
        'EX',
        RECORD_TTL_SECONDS,
        'NX',
      );
      return ok(undefined);
    } catch {
      return err({ code: 'STORE_UNAVAILABLE', httpStatus: 503 });
    }
  }

  /**
   * Tenta adquirir um lock distribuido sobre lock:{key} com TTL 10s.
   * Sucesso -> Lock; lock contention -> null; infra fora -> STORE_UNAVAILABLE.
   */
  public async acquireLock(
    key: string,
  ): Promise<Result<Lock | null, IdempotencyError>> {
    try {
      const lock = await this.redlock.acquire(
        [LOCK_PREFIX + key],
        LOCK_TTL_MS,
      );
      return ok(lock);
    } catch (error) {
      const name = (error as Error | null)?.constructor?.name ?? '';
      if (name === 'ResourceLockedError' || name === 'ExecutionError') {
        return ok(null);
      }
      return err({ code: 'STORE_UNAVAILABLE', httpStatus: 503 });
    }
  }

  /** Libera o lock. Falhas silenciadas - TTL expira sozinho. */
  public async releaseLock(lock: Lock): Promise<void> {
    try {
      await lock.release();
    } catch {
      /* swallow */
    }
  }

  private recordKey(key: string): string {
    return `idemp:${key}`;
  }
}

export const idempotencyStore = new IdempotencyStore();
