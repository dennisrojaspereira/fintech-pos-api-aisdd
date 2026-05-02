/**
 * Vitest com dois projetos: `unit` (mock-driven, rápido) e `integration`
 * (Postgres+Redis reais via docker-compose).
 *
 * Reqs 1.1, 7.1 — separação para não bloquear feedback unitário em testes
 * de infraestrutura, e permitir CI rodar suites em paralelo.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    reporters: 'default',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    workspace: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**'],
          environment: 'node',
          // Tarefas 16.x devem rodar contra Postgres+Redis docker.
          // Aumenta timeout para suportar boot do acquirer-stub e migrations.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
