/**
 * Env loader fail-fast.
 *
 * Lê variáveis de ambiente uma única vez ao bootstrap e valida com zod.
 * Se qualquer variável obrigatória estiver ausente ou inválida, o processo
 * encerra antes de aceitar tráfego (alinhado a design.md "fail-fast at startup").
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_PUBLIC_KEY: z
    .string()
    .min(1, 'JWT_PUBLIC_KEY é obrigatório (PEM RS256)')
    .refine(
      (v) => v.includes('BEGIN PUBLIC KEY') && v.includes('END PUBLIC KEY'),
      'JWT_PUBLIC_KEY precisa estar no formato PEM (BEGIN/END PUBLIC KEY)'
    ),
  JWT_ISSUER: z.string().min(1),

  ACQUIRER_BASE_URL: z.string().url(),
  ACQUIRER_API_KEY: z.string().min(1),
  ACQUIRER_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

  RECONCILIATION_ASYNC_THRESHOLD: z.coerce.number().int().positive().default(10_000),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('fintech-pos-api'),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

/**
 * Resolve e valida a env. Lança erro detalhado em caso de violação.
 * Use uma única vez no bootstrap (`src/index.ts`).
 */
export function loadEnv(): AppEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Falha fatal antes de aceitar tráfego.
    // eslint-disable-next-line no-console
    console.error(
      `\n[fintech-pos-api] Falha ao carregar variáveis de ambiente:\n${formatted}\n`
    );
    process.exit(1);
  }

  // Normaliza \n literais em chaves PEM coladas como string única
  const env: AppEnv = {
    ...parsed.data,
    JWT_PUBLIC_KEY: parsed.data.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
  };

  cached = env;
  return env;
}
