/**
 * Idempotency pre-handler — POST /transactions only.
 *
 * Source: design.md "Idempotency Middleware" + requirements 7.1, 7.2, 7.4.
 *
 * Escopo desta task (5.2):
 *   - Pre-handler Fastify aplicado APENAS a POST /transactions (registrar
 *     como hook por-rota, NUNCA global). Exporta:
 *       - `idempotencyPreHandler`: a função preHandler.
 *       - `registerIdempotencyForRoute(app)`: plugin que prende o hook
 *         por-rota usando `onRoute` + `addHook('preHandler', ...)` apenas
 *         na rota POST /transactions, e o hook `onSend` que captura a
 *         resposta serializada para persistir após o handler responder.
 *
 *   - Fluxo:
 *       1. Lê header `Idempotency-Key`. Se ausente → 422 (também aceitamos
 *          o schema da rota como linha de defesa primária).
 *       2. `acquireLock(key)`. Lock=null (concorrência) → 409.
 *          STORE_UNAVAILABLE → safe-mode (log warn + segue sem cache).
 *       3. `lookup(key)`. Hit → desserializa SerializedResponse, copia
 *          headers + body, ADICIONA `Idempotent-Replayed: true`, responde
 *          com `httpStatus` armazenado, libera lock e encerra.
 *       4. Miss → segue ao handler. Em `onSend`, captura body+status+
 *          headers e chama `store(key, serializedResponse)`. Em qualquer
 *          caminho (success/erro), libera o lock no finally (via
 *          `onResponse` para garantir).
 *
 *   - Safe-mode: se `acquireLock` ou `lookup` retornarem
 *     `STORE_UNAVAILABLE` (Redis offline), o middleware emite um warn
 *     estruturado via `request.log.warn(...)` e SEGUE adiante sem
 *     bloquear a autorização. Isso é intencional — req 1.6 e nota do
 *     design.md ("Redis unavailability must not block authorization;
 *     implement a safe-mode fallback that skips idempotency checking and
 *     logs a warning").
 *
 * Integração futura (Task 13.1):
 *   `registerIdempotencyForRoute(app)` deve ser chamado dentro do plugin
 *   que registra a rota POST /transactions, ANTES de `app.post(...)`.
 *
 * Requirements: 7.1, 7.2, 7.4 (+ 1.6 safe-mode).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
  RouteOptions,
} from 'fastify';

import type { SerializedResponse } from '../../../shared/types.js';
import {
  IdempotencyStore,
  idempotencyStore as defaultStore,
  type Lock,
} from '../../cache/idempotency-store.js';

/** Header padrão usado pela req 7.1. */
const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Header de marcação de replay (req 7.4). */
const REPLAYED_HEADER = 'idempotent-replayed';

/** Path-only matcher para a rota POST /transactions. */
const TARGET_PATH = '/transactions';
const TARGET_METHOD = 'POST';

/**
 * Contexto anexado em `request.idempotencyContext` quando o middleware
 * está ativo para uma requisição. O hook `onSend` consome isso para
 * persistir a resposta após o handler responder.
 */
export interface IdempotencyRequestContext {
  readonly key: string;
  /** Lock distribuído ativo. `null` quando rodamos em safe-mode degradado. */
  readonly lock: Lock | null;
  /** Indica se o store está acessível; quando `false` skipamos persist. */
  readonly storeAvailable: boolean;
  /**
   * Marcado `true` quando o pre-handler já respondeu (cache hit ou 409).
   * O hook `onSend` checa isto para evitar duplo-envio.
   */
  alreadyReplied: boolean;
  /** Marcado `true` após o `store(...)` ser executado com sucesso. */
  persisted: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populado pelo `idempotencyPreHandler` quando a rota é
     * POST /transactions e há `Idempotency-Key` válido.
     */
    idempotencyContext?: IdempotencyRequestContext;
  }
}

/**
 * Cria a função preHandler. Permite injeção do `IdempotencyStore` (útil
 * em testes — ver Task 15.3).
 */
export function buildIdempotencyPreHandler(
  store: IdempotencyStore = defaultStore,
): preHandlerAsyncHookHandler {
  return async function idempotencyPreHandlerImpl(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = readKey(request);
    if (key === null) {
      // O schema da rota deve ter validado este header como `required`.
      // Aqui é a linha-de-defesa secundária (req 7.1).
      void reply.code(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Idempotency-Key header is required',
          fields: [{ field: 'Idempotency-Key', message: 'required' }],
        },
      });
      return;
    }

    // ── 1) Tenta adquirir o lock distribuido.
    const lockResult = await store.acquireLock(key);
    if (!lockResult.ok) {
      // STORE_UNAVAILABLE -> safe-mode. Logar e seguir SEM cache.
      request.log.warn(
        { idempotencyKey: key, code: lockResult.error.code },
        'idempotency: store unavailable - proceeding in safe-mode',
      );
      request.idempotencyContext = {
        key,
        lock: null,
        storeAvailable: false,
        alreadyReplied: false,
        persisted: false,
      };
      return;
    }

    const lock = lockResult.value;
    if (lock === null) {
      // Lock contention - outra request com a mesma key esta em voo.
      void reply.code(409).send({
        error: {
          code: 'CONCURRENT_REQUEST',
          message:
            'Another request with the same Idempotency-Key is in flight',
        },
      });
      return;
    }

    // ── 2) Cache lookup.
    const lookupResult = await store.lookup(key);
    if (!lookupResult.ok) {
      // Lookup falhou (Redis caiu entre o lock e o get). Solta o lock,
      // entra em safe-mode.
      await store.releaseLock(lock);
      request.log.warn(
        { idempotencyKey: key, code: lookupResult.error.code },
        'idempotency: lookup failed - proceeding in safe-mode',
      );
      request.idempotencyContext = {
        key,
        lock: null,
        storeAvailable: false,
        alreadyReplied: false,
        persisted: false,
      };
      return;
    }

    const cached = lookupResult.value;
    if (cached !== null) {
      // ── HIT - replay da resposta original com header `Idempotent-Replayed: true`.
      replayCachedResponse(reply, cached);
      // Marca contexto e libera o lock - nao precisamos manter por replay.
      await store.releaseLock(lock);
      request.idempotencyContext = {
        key,
        lock: null,
        storeAvailable: true,
        alreadyReplied: true,
        persisted: true,
      };
      return;
    }

    // ── 3) Miss - segue ao handler. Lock fica pendurado para o onSend/onResponse.
    request.idempotencyContext = {
      key,
      lock,
      storeAvailable: true,
      alreadyReplied: false,
      persisted: false,
    };
  };
}

/**
 * Pre-handler default (singleton store). Use este export em rotas; para
 * testes injetar via `buildIdempotencyPreHandler(mockStore)`.
 */
export const idempotencyPreHandler: preHandlerAsyncHookHandler =
  buildIdempotencyPreHandler();

/**
 * Plugin Fastify que prende os hooks `preHandler` e `onSend`/`onResponse`
 * APENAS a rota POST /transactions. Use dentro do plugin de rotas (Task
 * 13.1) ANTES de declarar `app.post('/transactions', ...)`.
 *
 * Implementa via `onRoute` para inspecionar cada rota registrada e
 * injetar os hooks ao matchar method+url. Isso preserva o requisito do
 * design.md de "Applied as a Fastify preHandler hook on POST
 * /transactions only" (nao global).
 */
export function registerIdempotencyForRoute(
  app: FastifyInstance,
  store: IdempotencyStore = defaultStore,
): void {
  const preHandler = buildIdempotencyPreHandler(store);

  app.addHook('onRoute', (route: RouteOptions) => {
    const method = Array.isArray(route.method)
      ? route.method.includes(TARGET_METHOD)
      : route.method === TARGET_METHOD;
    if (!method) return;
    if (route.url !== TARGET_PATH) return;

    // Encadeia o preHandler (preservando outros ja configurados).
    route.preHandler = mergeHook(route.preHandler, preHandler);

    // onSend captura o body serializado pelo Fastify ANTES de mandar para
    // a rede. E o ponto certo para persistir a resposta cacheavel.
    route.onSend = mergeHook(route.onSend, buildOnSendHook(store));

    // onResponse libera o lock independentemente de sucesso/erro
    // (defense-in-depth caso onSend nao dispare).
    route.onResponse = mergeHook(route.onResponse, buildOnResponseHook(store));
  });
}

// ───────────────────────────── helpers ─────────────────────────────

function readKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function replayCachedResponse(
  reply: FastifyReply,
  cached: SerializedResponse,
): void {
  // Copia headers preservando case-insensitive lower.
  for (const [name, value] of Object.entries(cached.headers)) {
    void reply.header(name, value);
  }
  void reply.header(REPLAYED_HEADER, 'true');
  void reply.code(cached.httpStatus);
  void reply.type(cached.headers['content-type'] ?? 'application/json');
  void reply.send(cached.body);
}

/**
 * onSend hook - captura a resposta cacheavel e a persiste em background.
 * Recebe `payload` (string | Buffer | Stream); so tratamos string|Buffer.
 */
function buildOnSendHook(store: IdempotencyStore) {
  return async function idempotencyOnSend(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const ctx = request.idempotencyContext;
    if (!ctx) return payload;
    if (ctx.alreadyReplied) return payload;
    if (!ctx.storeAvailable) return payload;
    if (ctx.persisted) return payload;

    const status = reply.statusCode;
    // Persistimos apenas respostas finais cacheaveis (2xx). Erros 5xx
    // nao devem ser cacheados pois um retry deve poder tentar novamente.
    if (status < 200 || status >= 500) return payload;

    const bodyStr = serializePayload(payload);
    if (bodyStr === null) {
      return payload;
    }

    const headers = collectStringHeaders(reply);

    const serialized: SerializedResponse = {
      httpStatus: status,
      body: bodyStr,
      headers,
    };

    const result = await store.store(ctx.key, serialized);
    if (result.ok) {
      ctx.persisted = true;
    } else {
      request.log.warn(
        { idempotencyKey: ctx.key, code: result.error.code },
        'idempotency: failed to persist response - safe-mode',
      );
    }
    return payload;
  };
}

/**
 * onResponse hook - libera o lock apos a resposta ter sido enviada.
 * Garantia de que o lock NAO sobrevive ao request, mesmo em erro.
 */
function buildOnResponseHook(store: IdempotencyStore) {
  return async function idempotencyOnResponse(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const ctx = request.idempotencyContext;
    if (!ctx) return;
    if (ctx.lock === null) return;
    try {
      await store.releaseLock(ctx.lock);
    } catch {
      /* swallow - TTL expira */
    }
  };
}

function serializePayload(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Buffer) return payload.toString('utf8');
  if (payload === null || payload === undefined) return '';
  // Object literal pre-serializacao? Em Fastify v5 o payload chega
  // string ou Buffer no onSend; um objeto seria inesperado mas vamos
  // tentar JSON.stringify defensivo.
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function collectStringHeaders(
  reply: FastifyReply,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const all = reply.getHeaders();
  for (const [name, value] of Object.entries(all)) {
    if (typeof value === 'string') {
      out[name.toLowerCase()] = value;
    } else if (typeof value === 'number') {
      out[name.toLowerCase()] = String(value);
    } else if (Array.isArray(value)) {
      out[name.toLowerCase()] = value.join(', ');
    }
  }
  return Object.freeze(out);
}

// `mergeHook` aceita um hook unico, array ou undefined e retorna um
// array para preservar os existentes.
function mergeHook<T>(existing: T | T[] | undefined, toAdd: T): T[] {
  if (existing === undefined) return [toAdd];
  if (Array.isArray(existing)) return [...existing, toAdd];
  return [existing, toAdd];
}
