/**
 * Enums do domínio — fonte de verdade compartilhada.
 *
 * NÃO redefinir esses literais em outros módulos. Importe daqui.
 */

export const TransactionStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  VOIDED: 'VOIDED',
  SETTLED: 'SETTLED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const PaymentMethodType = {
  CREDIT_CARD: 'CREDIT_CARD',
  DEBIT_CARD: 'DEBIT_CARD',
  CONTACTLESS_NFC: 'CONTACTLESS_NFC',
} as const;
export type PaymentMethodType = (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

export const SettlementStatus = {
  PENDING_SETTLEMENT: 'PENDING_SETTLEMENT',
  SETTLED: 'SETTLED',
} as const;
export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const AuditAction = {
  AUTHORIZE: 'AUTHORIZE',
  VOID: 'VOID',
  RECONCILIATION_READ: 'RECONCILIATION_READ',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ReconciliationJobStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type ReconciliationJobStatus =
  (typeof ReconciliationJobStatus)[keyof typeof ReconciliationJobStatus];
