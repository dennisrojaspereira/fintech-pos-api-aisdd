/**
 * MonetaryAmount value object.
 *
 * Source: design.md "Domain Model / Value Objects" e requirements 1.8.
 * Invariantes:
 *   - amount é inteiro positivo, representado na menor unidade da moeda
 *     (ex.: centavos), evitando erros de ponto flutuante (req 1.8).
 *   - currency é um código ISO 4217 com exatamente 3 letras maiúsculas.
 *
 * Construído via factory `MonetaryAmount.create()` que retorna
 * `Result<MonetaryAmount, MonetaryAmountError>` para que o domínio
 * trate falhas de invariantes sem exceptions.
 */

import { err, ok, type Result } from '../../shared/result.js';

export type MonetaryAmountError =
  | { readonly code: 'AMOUNT_NOT_POSITIVE_INTEGER' }
  | { readonly code: 'CURRENCY_INVALID_FORMAT' };

const ISO_4217_PATTERN = /^[A-Z]{3}$/;

export class MonetaryAmount {
  public readonly amount: number;
  public readonly currency: string;

  private constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * Factory que valida invariantes (req 1.8 — amount > 0; ISO 4217).
   */
  public static create(
    amount: number,
    currency: string,
  ): Result<MonetaryAmount, MonetaryAmountError> {
    if (!Number.isInteger(amount) || amount <= 0) {
      return err({ code: 'AMOUNT_NOT_POSITIVE_INTEGER' });
    }
    if (typeof currency !== 'string' || !ISO_4217_PATTERN.test(currency)) {
      return err({ code: 'CURRENCY_INVALID_FORMAT' });
    }
    return ok(new MonetaryAmount(amount, currency));
  }

  public equals(other: MonetaryAmount): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}
