/**
 * Barrel dos value objects do domínio.
 *
 * Re-exporta também os enums compartilhados (TransactionStatus,
 * PaymentMethodType) para conveniência — fonte de verdade permanece em
 * `src/shared/enums.ts`.
 */

export { MonetaryAmount, type MonetaryAmountError } from './monetary-amount.js';
export { MaskedPan, type MaskedPanError } from './masked-pan.js';
export { AuthorizationCode, type AuthorizationCodeError } from './authorization-code.js';
export { TransactionStatus, PaymentMethodType } from '../../shared/enums.js';
