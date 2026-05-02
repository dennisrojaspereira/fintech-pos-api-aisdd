/**
 * JWT helper para testes de integracao.
 *
 * Gera um par de chaves RSA RS256 ao boot, exporta a chave publica em
 * formato PEM (sera injetada em `process.env.JWT_PUBLIC_KEY`) e oferece
 * `signTestJwt(claims)` para assinar tokens com claims compativeis com
 * o middleware `verifyJwt` (auth.ts).
 *
 * Uso:
 *   - Importe ANTES de carregar `tests/setup/env.js` para que a chave
 *     publica seja persistida em `process.env.JWT_PUBLIC_KEY`. O loader
 *     de env.ts so escreve em process.env quando a chave esta ausente,
 *     entao tambem aceitamos sobrescrever a chave default do .env.test.
 *
 * Reqs alvo: 6.1, 6.2 (formato RS256, claims merchantId/scopes/exp/iss).
 */

import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { AccountStatus } from '../../src/shared/enums.js';

export interface TestJwtClaims {
  readonly merchantId: string;
  readonly terminalId?: string | null;
  readonly operatorId?: string | null;
  readonly scopes?: readonly string[];
  readonly accountStatus?: keyof typeof AccountStatus;
  /** Em segundos desde a epoch. Default: agora + 1h. */
  readonly exp?: number;
  /** Default: env.JWT_ISSUER (`fintech-pos-test`). */
  readonly iss?: string;
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

export const TEST_JWT_PUBLIC_KEY: string = publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();

const TEST_JWT_PRIVATE_KEY: string = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

/**
 * Sobrescreve `process.env.JWT_PUBLIC_KEY` com a chave publica do
 * keypair gerado em runtime. Idempotente: chamadas subsequentes com a
 * mesma chave nao tem efeito. Pode ser chamado antes de qualquer
 * `loadEnv()` para garantir que o env validado pelo zod use a chave
 * compativel com `signTestJwt`.
 */
export function injectTestPublicKey(): void {
  process.env['JWT_PUBLIC_KEY'] = TEST_JWT_PUBLIC_KEY;
  if (process.env['JWT_ISSUER'] === undefined) {
    process.env['JWT_ISSUER'] = 'fintech-pos-test';
  }
}

/**
 * Assina um JWT RS256 para uso nos testes de integracao. Claims
 * obrigatorias do middleware (verifyJwt):
 *   - merchantId (string)
 *   - scopes (string[])
 *   - accountStatus (ACTIVE/INACTIVE/SUSPENDED)
 *   - exp (Date claim valido)
 *   - iss (`fintech-pos-test` por default)
 */
export function signTestJwt(claims: TestJwtClaims): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = claims.exp ?? nowSec + 3600;
  const iss = claims.iss ?? process.env['JWT_ISSUER'] ?? 'fintech-pos-test';

  const payload: Record<string, unknown> = {
    merchantId: claims.merchantId,
    terminalId: claims.terminalId ?? null,
    operatorId: claims.operatorId ?? null,
    scopes: claims.scopes ?? [],
    accountStatus: claims.accountStatus ?? AccountStatus.ACTIVE,
    iss,
    exp,
  };

  return jwt.sign(payload, TEST_JWT_PRIVATE_KEY, { algorithm: 'RS256' });
}

/** Header `Authorization: Bearer <token>` pronto para `app.inject({ headers })`. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}
