# Requirements Document

## Introduction

The POS Transactions API is a REST service responsible for authorizing payment transactions at the Point-of-Sale, issuing transaction receipts, and providing data for reconciliation with the payment acquirer. It serves three primary personas: the merchant (PDV operator) who initiates and manages transactions, the end customer (payer) whose payment is processed, and the backoffice team that performs financial reconciliation.

## Requirements

### Requirement 1: Transaction Authorization

**Objective:** As a merchant, I want to submit a payment transaction for authorization, so that I can accept payments from customers at the point of sale.

#### Acceptance Criteria

1. When a merchant submits a payment authorization request with a valid amount, currency, payment instrument, and terminal identifier, the POS Transactions API shall return an authorization response with a unique transaction ID, authorization code, and status within 30 seconds.
2. When a merchant submits an authorization request, the POS Transactions API shall validate that the request body contains all required fields (amount, currency, payment method type, terminal ID, and merchant ID) before forwarding to the acquirer.
3. If any required field is missing or invalid in the authorization request, the POS Transactions API shall return HTTP 422 with a structured error response identifying each invalid field.
4. When the acquirer approves the transaction, the POS Transactions API shall persist the transaction record with status `APPROVED` and return HTTP 201 with the full transaction details.
5. When the acquirer declines the transaction, the POS Transactions API shall persist the transaction record with status `DECLINED`, include the acquirer decline reason code, and return HTTP 200 with the declined transaction details.
6. If the acquirer gateway is unreachable or returns a timeout, the POS Transactions API shall persist the transaction with status `PENDING` and return HTTP 202 so the terminal can poll for the final status.
7. The POS Transactions API shall support payment method types: credit card, debit card, and contactless (NFC).
8. The POS Transactions API shall accept transaction amounts as integers in the smallest currency unit (e.g., cents) to avoid floating-point precision errors.

---

### Requirement 2: Transaction Status Query

**Objective:** As a merchant, I want to query the status of a submitted transaction, so that I can confirm authorization outcomes and handle pending states.

#### Acceptance Criteria

1. When a merchant requests the status of a transaction by its transaction ID, the POS Transactions API shall return the current transaction record including status, timestamps, and authorization code (if approved).
2. If the requested transaction ID does not exist or belongs to a different merchant, the POS Transactions API shall return HTTP 404.
3. While a transaction is in `PENDING` status, the POS Transactions API shall return the most recent status data and the timestamp of the last acquirer check.
4. When a `PENDING` transaction has been resolved by the acquirer, the POS Transactions API shall reflect the final status (`APPROVED` or `DECLINED`) on the next status query.
5. The POS Transactions API shall support paginated listing of transactions filtered by terminal ID, date range, and status.

---

### Requirement 3: Transaction Cancellation (Void)

**Objective:** As a merchant, I want to cancel an approved transaction before settlement, so that I can correct errors or reverse unintended charges.

#### Acceptance Criteria

1. When a merchant submits a void request for an `APPROVED` transaction that has not yet been settled, the POS Transactions API shall send a void request to the acquirer and update the transaction status to `VOIDED` upon acquirer confirmation.
2. If a void request is submitted for a transaction that is already `VOIDED`, `SETTLED`, or `DECLINED`, the POS Transactions API shall return HTTP 409 with a message indicating the transaction is not eligible for void.
3. When the acquirer confirms the void, the POS Transactions API shall record the void timestamp and the operator identity that performed the void.
4. If the acquirer rejects the void request, the POS Transactions API shall retain the original transaction status unchanged and return HTTP 422 with the acquirer rejection reason.
5. The POS Transactions API shall require explicit void authorization by an authenticated operator with the `transactions:void` permission scope.

---

### Requirement 4: Receipt Issuance

**Objective:** As a merchant, I want to retrieve a transaction receipt after authorization, so that I can provide proof of payment to the customer.

#### Acceptance Criteria

1. When a merchant requests a receipt for an `APPROVED` or `VOIDED` transaction, the POS Transactions API shall return a receipt payload containing: transaction ID, merchant name, terminal ID, amount, currency, payment method masked details, authorization code, and transaction timestamp.
2. If a receipt is requested for a `DECLINED` or `PENDING` transaction, the POS Transactions API shall return HTTP 409 indicating a receipt is not available for that transaction state.
3. The POS Transactions API shall support receipt output in JSON format for programmatic use by the terminal.
4. Where the merchant's configuration includes a receipt template, the POS Transactions API shall render the receipt using that template.
5. The POS Transactions API shall mask the primary account number (PAN), displaying only the last 4 digits in all receipt and response payloads.

---

### Requirement 5: Acquirer Reconciliation Data

**Objective:** As a backoffice operator, I want to retrieve transaction data for a settlement period, so that I can reconcile processed transactions with the acquirer's settlement report.

#### Acceptance Criteria

1. When a backoffice operator requests the reconciliation report for a given date and terminal or merchant, the POS Transactions API shall return a list of all `APPROVED` and `VOIDED` transactions for that period with totals by payment method type.
2. The POS Transactions API shall expose a reconciliation endpoint that requires the `reconciliation:read` permission scope.
3. When a reconciliation request specifies a date range exceeding 31 days, the POS Transactions API shall return HTTP 400 indicating the maximum allowed range.
4. The POS Transactions API shall include in each reconciliation record: transaction ID, amount, currency, payment method type, authorization code, settlement status, and acquirer reference number.
5. While a reconciliation export is being generated for large result sets, the POS Transactions API shall support asynchronous job creation and return a job ID for polling.

---

### Requirement 6: Authentication and Authorization

**Objective:** As a system administrator, I want all API endpoints to be protected by authentication and fine-grained authorization, so that only authorized operators and systems can perform sensitive operations.

#### Acceptance Criteria

1. The POS Transactions API shall require a valid JWT bearer token on every request to protected endpoints.
2. If a request arrives without a token or with an expired token, the POS Transactions API shall return HTTP 401.
3. If a valid token does not include the required permission scope for the requested operation, the POS Transactions API shall return HTTP 403.
4. The POS Transactions API shall enforce that a terminal or merchant can only access transactions belonging to its own account.
5. When a token is valid but the associated merchant account is inactive or suspended, the POS Transactions API shall return HTTP 403 with an account status reason.

---

### Requirement 7: Idempotency and Duplicate Prevention

**Objective:** As a merchant, I want to safely retry authorization requests without creating duplicate transactions, so that network failures do not result in double charges.

#### Acceptance Criteria

1. When an authorization request includes an `Idempotency-Key` header, the POS Transactions API shall detect if an identical key was used within the last 24 hours and return the original response without processing a new transaction.
2. If two concurrent requests with the same `Idempotency-Key` arrive simultaneously, the POS Transactions API shall process only one and return HTTP 409 to the duplicate request.
3. The POS Transactions API shall store idempotency keys and their associated responses for a minimum of 24 hours.
4. When an idempotency key match is found, the POS Transactions API shall indicate in the response that it is a cached result via a response header (e.g., `Idempotent-Replayed: true`).

---

### Requirement 8: Observability and Audit Logging

**Objective:** As a backoffice operator, I want all transaction operations to be fully logged and traceable, so that I can investigate disputes and monitor system health.

#### Acceptance Criteria

1. The POS Transactions API shall emit structured JSON logs for every inbound request and outbound response, including correlation ID, merchant ID, terminal ID, operation type, and latency.
2. The POS Transactions API shall propagate OpenTelemetry trace context across all acquirer calls and internal service boundaries.
3. When an authorization, void, or reconciliation operation completes, the POS Transactions API shall write an immutable audit log entry recording the actor identity, action, resource ID, timestamp, and outcome.
4. If an audit log write fails, the POS Transactions API shall not fail the business operation but shall emit a critical-level alert to the observability pipeline.
5. The POS Transactions API shall expose a `/health` endpoint returning service status without requiring authentication, suitable for liveness and readiness probes.
