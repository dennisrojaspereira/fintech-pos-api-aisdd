/**
 * OpenTelemetry SDK bootstrap + W3C Trace-Context propagation helper.
 *
 * Implementa requirement 8.2: tracing distribuido propagado em todas as
 * chamadas externas e nas fronteiras internas do servico.
 *
 * Responsabilidades:
 *   - `startTelemetry(env)`: inicializa `@opentelemetry/sdk-node` com
 *     auto-instrumentations (Fastify, Prisma, ioredis, undici). Idempotente.
 *   - `shutdownTelemetry()`: desliga o SDK (deve ser chamado em SIGTERM/SIGINT).
 *   - `injectW3CTraceContext(headers)`: API estavel para o Acquirer Adapter
 *     (task 6.1) injetar `traceparent` / `tracestate` em headers outbound.
 *
 * Decisões:
 *   - Tracer name: `fintech-pos-api` (alinhado com OTEL_SERVICE_NAME default).
 *   - Exportador: OTLP HTTP se `OTEL_EXPORTER_OTLP_ENDPOINT` setado; caso
 *     contrario o SDK Node usa o exportador default. Em dev sem endpoint
 *     OTLP, o auto-config do sdk-node mantem spans em batch sem exportar
 *     externamente — comportamento aceitavel para desenvolvimento local.
 */

import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import type { AppEnv } from '../../config/env.js';

export const TRACER_NAME = 'fintech-pos-api';

let sdkInstance: NodeSDK | undefined;
let started = false;

/**
 * Inicializa o NodeSDK do OpenTelemetry uma unica vez.
 *
 * Deve ser chamado *antes* de carregar modulos instrumentados (idealmente em
 * `src/index.ts` antes do `buildServer`).
 */
export function startTelemetry(env: AppEnv): void {
  if (started) return;
  started = true;

  // Repasse para variaveis padronizadas do OTel SDK quando aplicavel.
  // O SDK ja respeita process.env.OTEL_*; aqui apenas garantimos consistencia
  // com o nome de servico configurado via zod.
  if (!process.env['OTEL_SERVICE_NAME']) {
    process.env['OTEL_SERVICE_NAME'] = env.OTEL_SERVICE_NAME;
  }
  if (
    env.OTEL_EXPORTER_OTLP_ENDPOINT &&
    !process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  ) {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }

  sdkInstance = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduzir ruido: o instrumentor de fs gera span por leitura de arquivo.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdkInstance.start();
}

/**
 * Desliga o SDK gracefully. Use no handler de SIGTERM / SIGINT do bootstrap.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdkInstance) return;
  try {
    await sdkInstance.shutdown();
  } finally {
    sdkInstance = undefined;
    started = false;
  }
}

/**
 * Injeta os headers W3C Trace-Context (`traceparent`, `tracestate`) no objeto
 * de headers fornecido, baseado no span ativo.
 *
 * API estavel consumida pelo Acquirer Adapter (task 6.1) — NÃO renomear.
 *
 * Quando nao houver span ativo (ex.: chamada feita fora do request lifecycle),
 * a propagacao vira um no-op silencioso e o objeto retorna inalterado.
 */
export function injectW3CTraceContext(
  headers: Record<string, string>
): Record<string, string> {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => {
      if (typeof value === 'string') {
        (carrier as Record<string, string>)[key] = value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        (carrier as Record<string, string>)[key] = String(value);
      }
    },
  });
  return headers;
}

/**
 * Helper para obter o tracer canonico do servico.
 *
 * Ex.: `getTracer().startSpan('acquirer.authorize')`.
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}
