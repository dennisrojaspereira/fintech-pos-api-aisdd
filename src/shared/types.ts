/**
 * Tipos compartilhados extraídos diretamente do design.md.
 * Estes contratos são **fonte única**: agentes não devem redefini-los.
 */

import type {
  AccountStatus,
  PaymentMethodType,
  SettlementStatus,
  TransactionStatus,
  ReconciliationJobStatus,
  AuditAction,
} from './enums.js';

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────

export interface AuthContext {
  readonly merchantId: string;
  readonly terminalId: string | null;
  readonly operatorId: string | null;
  readonly scopes: readonly string[];
  readonly accountStatus: AccountStatus;
}

export type AuthError =
  | { code: 'TOKEN_MISSING' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID'; httpStatus: 401 }
  | {
      code: 'SCOPE_MISSING' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_INACTIVE';
      httpStatus: 403;
      reason?: string;
    };

// ─────────────────────────────────────────────
// Transaction
// ─────────────────────────────────────────────

export interface PaymentMethodInput {
  readonly type: PaymentMethodType;
  /** Apenas últimos 4 dígitos no formato `****1234`. PAN completo é rejeitado. */
  readonly maskedPan: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
}

export interface AuthorizeCommand {
  readonly merchantId: string;
  readonly terminalId: string;
  /** Inteiro na menor unidade da moeda (ex.: centavos). > 0. */
  readonly amount: number;
  /** ISO 4217 (3 letras). */
  readonly currency: string;
  readonly paymentMethod: PaymentMethodInput;
  readonly idempotencyKey: string;
}

export interface TransactionRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly terminalId: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodType: PaymentMethodType;
  readonly maskedPan: string;
  readonly status: TransactionStatus;
  readonly authorizationCode: string | null;
  readonly acquirerReferenceNumber: string | null;
  readonly acquirerDeclineCode: string | null;
  readonly voidedBy: string | null;
  readonly voidedAt: string | null;
  readonly lastAcquirerCheckAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface TransactionResult {
  readonly transactionId: string;
  readonly status: TransactionStatus;
  readonly authorizationCode: string | null;
  readonly acquirerDeclineCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type TransactionError =
  | { code: 'VALIDATION_ERROR'; fields: readonly FieldError[]; httpStatus: 422 }
  | { code: 'NOT_FOUND'; httpStatus: 404 }
  | { code: 'ACQUIRER_TIMEOUT'; httpStatus: 202 }
  | { code: 'CIRCUIT_OPEN'; httpStatus: 503; retryAfterSeconds: number }
  | { code: 'INTERNAL_ERROR'; httpStatus: 500 };

export interface TransactionListFilters {
  readonly merchantId: string;
  readonly terminalId?: string | undefined;
  readonly status?: TransactionStatus | undefined;
  readonly dateFrom?: Date | undefined;
  readonly dateTo?: Date | undefined;
  readonly page: number;
  readonly pageSize: number;
}

export interface PaginatedList<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

// ─────────────────────────────────────────────
// Void
// ─────────────────────────────────────────────

export interface VoidCommand {
  readonly transactionId: string;
  readonly merchantId: string;
  readonly operatorId: string;
}

export interface VoidResult {
  readonly transactionId: string;
  readonly status: 'VOIDED';
  readonly voidedAt: string;
  readonly voidedBy: string;
}

export type VoidError =
  | { code: 'NOT_ELIGIBLE'; currentStatus: TransactionStatus; httpStatus: 409 }
  | { code: 'ACQUIRER_REJECTED'; reason: string; httpStatus: 422 }
  | { code: 'NOT_FOUND'; httpStatus: 404 }
  | { code: 'CIRCUIT_OPEN'; httpStatus: 503; retryAfterSeconds: number };

// ─────────────────────────────────────────────
// Receipt
// ─────────────────────────────────────────────

export interface ReceiptPayload {
  readonly transactionId: string;
  readonly merchantName: string;
  readonly terminalId: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodType: PaymentMethodType;
  /** Sempre last-4 mascarado (`****1234`). */
  readonly maskedPan: string;
  readonly authorizationCode: string | null;
  readonly transactionTimestamp: string;
  readonly receiptTemplate: string | null;
}

export type ReceiptError =
  | { code: 'NOT_AVAILABLE'; currentStatus: TransactionStatus; httpStatus: 409 }
  | { code: 'NOT_FOUND'; httpStatus: 404 };

// ─────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────

export interface ReconciliationQuery {
  readonly merchantId: string;
  readonly terminalId?: string | undefined;
  readonly startDate: string; // ISO 8601 date
  readonly endDate: string;
  readonly pageSize?: number | undefined;
}

export interface ReconciliationRecord {
  readonly transactionId: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodType: PaymentMethodType;
  readonly authorizationCode: string;
  readonly settlementStatus: SettlementStatus;
  readonly acquirerReferenceNumber: string;
}

export interface ReconciliationSummary {
  readonly records: readonly ReconciliationRecord[];
  /** key = PaymentMethodType, value = total em cents. */
  readonly totalsByMethod: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

export interface ReconciliationJob {
  readonly jobId: string;
  readonly status: ReconciliationJobStatus;
  readonly resultUrl: string | null;
}

export type ReconciliationError =
  | { code: 'DATE_RANGE_EXCEEDED'; maxDays: 31; httpStatus: 400 }
  | { code: 'FORBIDDEN'; httpStatus: 403 }
  | { code: 'NOT_FOUND'; httpStatus: 404 };

// ─────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────

export interface SerializedResponse {
  readonly httpStatus: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface IdempotencyHit {
  readonly response: SerializedResponse;
  readonly replayed: true;
}

export type IdempotencyError =
  | { code: 'CONCURRENT_REQUEST'; httpStatus: 409 }
  | { code: 'STORE_UNAVAILABLE'; httpStatus: 503 };

// ─────────────────────────────────────────────
// Acquirer
// ─────────────────────────────────────────────

export interface W3CTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string | undefined;
}

export interface AcquirerAuthRequest {
  readonly merchantId: string;
  readonly terminalId: string;
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodType: PaymentMethodType;
  readonly maskedPan: string;
  readonly traceContext: W3CTraceContext;
}

export interface AcquirerVoidRequest {
  readonly authorizationCode: string;
  readonly originalAmount: number;
  readonly traceContext: W3CTraceContext;
}

export type AcquirerOutcome = 'APPROVED' | 'DECLINED' | 'TIMEOUT' | 'ERROR';

export interface AcquirerResult {
  readonly outcome: AcquirerOutcome;
  readonly authorizationCode: string | null;
  readonly acquirerReferenceNumber: string | null;
  readonly declineCode: string | null;
  readonly rawResponseCode: string | null;
}

export type AcquirerAdapterError =
  | { code: 'CIRCUIT_OPEN'; httpStatus: 503; retryAfterSeconds: number }
  | { code: 'SERIALIZATION_ERROR'; httpStatus: 500 };

// ─────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────

export interface AuditEntry {
  readonly id: string;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly resourceId: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}
