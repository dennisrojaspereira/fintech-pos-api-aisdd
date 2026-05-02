/**
 * MaskedPan value object.
 *
 * Source: design.md "Domain Model / Value Objects" e requirements 4.5,
 * Security Considerations ("Full PAN is never received, stored, or logged").
 *
 * Invariantes:
 *   - Casa o regex /^\*{4,}\d{4}$/ — exatamente um sufixo de 4 dígitos
 *     precedido por 4+ asteriscos.
 *   - REJEITA explicitamente PAN completo (13–19 dígitos) — defesa em
 *     profundidade caso o input chegue não-mascarado por erro.
 */

import { err, ok, type Result } from '../../shared/result.js';

export type MaskedPanError =
  | { readonly code: 'EMPTY' }
  | { readonly code: 'FULL_PAN_FORBIDDEN' }
  | { readonly code: 'INVALID_FORMAT' };

const MASKED_PATTERN = /^\*{4,}\d{4}$/;
const FULL_PAN_PATTERN = /^\d{13,19}$/;

export class MaskedPan {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }

  /**
   * Factory que enforça o invariante de mascaramento.
   */
  public static create(input: string): Result<MaskedPan, MaskedPanError> {
    if (typeof input !== 'string' || input.length === 0) {
      return err({ code: 'EMPTY' });
    }
    if (FULL_PAN_PATTERN.test(input)) {
      return err({ code: 'FULL_PAN_FORBIDDEN' });
    }
    if (!MASKED_PATTERN.test(input)) {
      return err({ code: 'INVALID_FORMAT' });
    }
    return ok(new MaskedPan(input));
  }

  /** Últimos 4 dígitos (sempre presentes pelo invariante). */
  public last4(): string {
    return this.value.slice(-4);
  }

  public toString(): string {
    return this.value;
  }
}
