/**
 * Fastify hooks para structured request/response logging.
 *
 * Implementa requirement 8.1: emitir um log JSON por request e por response,
 * incluindo correlationId, merchantId, terminalId, operacao (route + method),
 * httpStatus e latencia em milissegundos.
 *
 * Estrategia de severidade:
 *   - 5xx → `error`
 *   - 4xx → `warn`
 *   - else → `info`
 *
 * correlationId é resolvido nesta ordem:
 *   1. Header `x-correlation-id` (se presente) — útil para tracing cross-service.
 *   2. `request.id` gerado pelo Fastify (default).
 *
 * O hook é idempotente em relacao ao auth: campos vindos de `request.authContext`
 * só aparecem se o auth ja populou o contexto.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REQUEST_START_SYMBOL: unique symbol = Symbol('requestLogger.startNs');

interface AugmentedRequest extends FastifyRequest {
  [REQUEST_START_SYMBOL]?: bigint;
}

/**
 * Resolve o correlation id a partir do header X-Correlation-Id ou cai no
 * `request.id` gerado pelo Fastify.
 */
function resolveCorrelationId(request: FastifyRequest): string {
  const headerVal = request.headers['x-correlation-id'];
  if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  if (Array.isArray(headerVal) && headerVal.length > 0) {
    const first = headerVal[0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  return request.id;
}

function operationOf(request: FastifyRequest): string {
  // `routeOptions.url` (Fastify 5) preserva os placeholders (ex.: /transactions/:id),
  // o que evita explosao de cardinalidade nos logs/metrics.
  const routeUrl =
    request.routeOptions?.url ??
    // Fallback para versoes antigas do Fastify
    (request as unknown as { routerPath?: string }).routerPath ??
    request.url;
  return `${request.method} ${routeUrl}`;
}

/**
 * Registra os hooks `onRequest` e `onResponse` de logging estruturado.
 *
 * Idempotente: chame apenas uma vez por instancia Fastify.
 */
export function registerRequestLogger(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as AugmentedRequest)[REQUEST_START_SYMBOL] = process.hrtime.bigint();

    const correlationId = resolveCorrelationId(request);
    const ctx = request.authContext;

    request.log.info(
      {
        event: 'http.request',
        correlationId,
        method: request.method,
        operation: operationOf(request),
        ...(ctx
          ? {
              merchantId: ctx.merchantId,
              terminalId: ctx.terminalId,
            }
          : {}),
      },
      'inbound request'
    );
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const startNs = (request as AugmentedRequest)[REQUEST_START_SYMBOL];
    const durationMs =
      startNs !== undefined
        ? Number(process.hrtime.bigint() - startNs) / 1_000_000
        : reply.elapsedTime;

    const correlationId = resolveCorrelationId(request);
    const status = reply.statusCode;
    const ctx = request.authContext;

    const payload = {
      event: 'http.response',
      correlationId,
      method: request.method,
      operation: operationOf(request),
      httpStatus: status,
      durationMs,
      ...(ctx
        ? {
            merchantId: ctx.merchantId,
            terminalId: ctx.terminalId,
          }
        : {}),
    };

    if (status >= 500) {
      request.log.error(payload, 'outbound response');
    } else if (status >= 400) {
      request.log.warn(payload, 'outbound response');
    } else {
      request.log.info(payload, 'outbound response');
    }
  });
}
