/**
 * Helper para os testes: carrega variáveis de `.env.test` antes de
 * importar qualquer módulo que dependa de env.
 *
 * Uso: `import './setup/env.js'` no topo dos arquivos de teste, ou
 * referenciar como `setupFiles` no vitest.config.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../.env.test');

try {
  const content = readFileSync(envFile, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // Sem .env.test em CI: assume que o ambiente já foi exportado.
}
