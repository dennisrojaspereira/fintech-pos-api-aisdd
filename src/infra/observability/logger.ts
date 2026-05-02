/**
 * Pino logger factory.
 *
 * Implementa parte do requirement 8.1 (logs JSON estruturados).
 * Expõe um factory reutilizavel `createLogger(env)`. O `src/server.ts` ja
 * configura pino diretamente no FastifyInstance — este factory existe para
 * reuso fora do request lifecycle (workers BullMQ, scripts, etc.).
 *
 * Em desenvolvimento usa `pino-pretty` (transport opcional). Em qualquer outro
 * NODE_ENV mantem JSON puro para ingest em pipelines de observabilidade.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppEnv } from '../../config/env.js';

/**
 * Constroi opcoes de logger consistentes com `buildServer`.
 * Exposto para que o request-logger possa derivar instancias child.
 */
export function buildLoggerOptions(env: AppEnv): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: env.OTEL_SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, singleLine: true },
      },
    };
  }
  return base;
}

/**
 * Cria uma instancia pino independente do Fastify. Use em contextos que nao
 * possuem `request.log` (ex.: bullmq workers, scripts CLI).
 */
export function createLogger(env: AppEnv): Logger {
  return pino(buildLoggerOptions(env));
}
