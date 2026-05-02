/**
 * Entry point — bootstrap fail-fast.
 *
 * 1. Carrega e valida env (sai com código 1 se inválida).
 * 2. Inicia o OpenTelemetry SDK ANTES de carregar instrumentações no Fastify
 *    (req 8.2).
 * 3. Constrói a instância Fastify.
 * 4. Listen na porta configurada.
 *
 * SIGINT/SIGTERM resultam em shutdown gracioso, incluindo o telemetry SDK.
 */

import { buildServer } from './server.js';
import { loadEnv } from './config/env.js';
import {
  shutdownTelemetry,
  startTelemetry,
} from './infra/observability/tracing.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // Telemetry deve iniciar ANTES do buildServer para que as auto
  // instrumentations (Fastify, Prisma, ioredis, undici) consigam se
  // amarrar nos módulos no momento do require.
  startTelemetry(env);

  const app = await buildServer({ env });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      await shutdownTelemetry();
      process.exit(0);
    } catch (e) {
      app.log.error({ err: e }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    const address = await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info({ address }, 'fintech-pos-api listening');
  } catch (e) {
    app.log.error({ err: e }, 'failed to start server');
    process.exit(1);
  }
}

main().catch((e) => {
  // Falha durante o bootstrap (antes do logger estar pronto).
  // eslint-disable-next-line no-console
  console.error('[fintech-pos-api] bootstrap fatal:', e);
  process.exit(1);
});
