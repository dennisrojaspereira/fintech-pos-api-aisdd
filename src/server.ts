/**
 * Fastify server factory.
 *
 * Compõe os plugins na ordem:
 *   1. Swagger
 *   2. /health (público)
 *   3. registerAuth (onRequest com bypass para /health)
 *   4. registerRequestLogger
 *   5. setErrorHandler global (error-serializer)
 *   6. Rotas autenticadas sob /v1:
 *        - registerIdempotencyForRoute (POST /transactions only)
 *        - transactionsRoute / voidRoute / receiptRoute
 *        - reconciliationRoute
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { AppEnv } from './config/env.js';
import { registerSwagger } from './plugins/swagger.js';
import { healthRoute } from './infra/http/routes/health.route.js';
import { registerAuth } from './infra/http/middleware/auth.js';
import { registerRequestLogger } from './infra/observability/request-logger.js';
import { registerErrorHandler } from './infra/http/error-serializer.js';
import { registerIdempotencyForRoute } from './infra/http/middleware/idempotency.js';
import { transactionsRoute } from './infra/http/routes/transactions.route.js';
import { voidRoute } from './infra/http/routes/void.route.js';
import { receiptRoute } from './infra/http/routes/receipt.route.js';
import { reconciliationRoute } from './infra/http/routes/reconciliation.route.js';

export interface BuildServerOptions {
  readonly env: AppEnv;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.env.LOG_LEVEL,
      ...(opts.env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true },
            },
          }
        : {}),
    },
    ajv: {
      customOptions: {
        // additionalProperties:false a nível de rota é responsabilidade dos schemas.
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: true,
      },
    },
  });

  await registerSwagger(app);

  // Public route — antes do registerAuth (auth também faz bypass interno
  // para /health, mas registrar antes evita o overhead do hook).
  await app.register(healthRoute);

  // Auth + structured logging + error handler.
  registerAuth(app, { env: opts.env });
  registerRequestLogger(app);
  registerErrorHandler(app);

  // Rotas autenticadas sob /v1.
  await app.register(
    async (instance: FastifyInstance) => {
      // Idempotency hook é registrado dentro do encapsulamento /v1 — o
      // matcher path interno `/transactions` (sem prefixo) cobre apenas
      // POST /v1/transactions (req 7.1).
      registerIdempotencyForRoute(instance);

      await instance.register(transactionsRoute);
      await instance.register(voidRoute);
      await instance.register(receiptRoute);
      await instance.register(reconciliationRoute, { env: opts.env });
    },
    { prefix: '/v1' },
  );

  return app;
}
