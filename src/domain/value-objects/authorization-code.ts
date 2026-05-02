/**
 * AuthorizationCode value object — identificador retornado pelo acquirer
 * em transações APPROVED. Imutável após construção (req 1.4 / 4.1).
 *
 * Invariantes:
 *   - String não vazia (após trim) e <= 64 chars (alinhado ao schema
 *     prisma `authorization_code VARCHAR(64)`).
 */

import { err, ok, type Result } from '../../shared/result.js';

export type AuthorizationCodeError =
  | { readonly code: 'EMPTY' }
  | { readonly code: 'TOO_LONG' };

const MAX_LENGTH = 64;

export class AuthorizationCode {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }

  public static create(input: string): Result<AuthorizationCode, AuthorizationCodeError> {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return err({ code: 'EMPTY' });
    }
    if (input.length > MAX_LENGTH) {
      return err({ code: 'TOO_LONG' });
    }
    return ok(new AuthorizationCode(input));
  }

  public toString(): string {
    return this.value;
  }
}
