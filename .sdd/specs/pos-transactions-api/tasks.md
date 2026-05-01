# Implementation Plan

- [ ] 1. Project scaffolding and environment setup
- [ ] 1.1 Initialize the Fastify v5 + TypeScript project with Node.js 20 LTS
  - Create the project structure following the Layered Hexagonal (Ports & Adapters) pattern: HTTP transport, domain services, and infrastructure adapters in separate directories
  - Configure TypeScript 5.x with strict mode, path aliases, and ESM module resolution
  - Install and configure all core dependencies: Fastify v5, Prisma 5.x, ioredis, BullMQ 5.x, jsonwebtoken, Opossum 8.x, undici, pino, @opentelemetry/sdk-node
  - Set up environment variable loading with fail-fast validation at startup for all required secrets (JWT public key, database URL, Redis URL, acquirer credentials)
  - Configure fastify-swagger for auto-generated OpenAPI 3.1 spec from route schemas
  - _Requirements: 1.1, 6.1, 8.1_

- [ ] 1.2 Set up test infrastructure and CI configuration
  - Configure Vitest (or Jest) with separate projects for unit and integration tests
  - Set up Docker Compose with PostgreSQL 16 and Redis 7 for local integration test environment
  - Configure test environment variable overrides and test database seeding utilities
  - _Requirements: 1.1, 7.1_

- [ ] 2. Database schema and migrations
- [ ] 2.1 Define the Prisma schema for all data models
  - Define the `Transaction` model with all fields: id (UUID), merchant_id, terminal_id, amount (Int), currency, payment_method_type, masked_pan, status, authorization_code, acquirer_reference_number, acquirer_decline_code, voided_by, voided_at, created_at, updated_at, version (for optimistic locking)
  - Define the `AuditEntry` model as append-only: id, actor_id, action, resource_id, outcome, metadata (Json), timestamp
  - Define the `ReconciliationJob` model: id, merchant_id, terminal_id, start_date, end_date, status, result_url, created_at, updated_at
  - Add CHECK constraint on `status` column and `amount > 0`; configure `version` field for optimistic locking
  - _Requirements: 1.4, 1.5, 1.6, 3.3, 5.5, 8.3_

- [ ] 2.2 Create database indexes and security constraints
  - Add compound index on `(merchant_id, created_at DESC)` for list queries
  - Add compound index on `(terminal_id, status, created_at)` for reconciliation filters
  - Add partial index on `(status)` filtering for `PENDING` records
  - Add index on `(resource_id, timestamp DESC)` for the audit_entries table
  - Add index on `(merchant_id, created_at DESC)` for reconciliation_jobs
  - Revoke `DELETE` and `UPDATE` privileges on `audit_entries` from the API database role to enforce append-only immutability
  - _Requirements: 2.3, 2.5, 5.1, 8.3, 8.4_

- [ ] 3. Domain model: value objects, enums, and state machine
- [ ] 3.1 (P) Implement core value objects and enumerations
  - Implement `MonetaryAmount` value object with invariant enforcement: amount must be a positive integer and currency must be a 3-letter ISO 4217 code
  - Implement `MaskedPan` value object with regex invariant `/^\*{4,}\d{4}$/`; constructor rejects any input that does not match (full PANs are always rejected)
  - Implement `AuthorizationCode` as an immutable value object
  - Implement `PaymentMethodType` enum with values: `CREDIT_CARD`, `DEBIT_CARD`, `CONTACTLESS_NFC`
  - Implement `TransactionStatus` enum: `PENDING`, `APPROVED`, `DECLINED`, `VOIDED`, `SETTLED`
  - _Requirements: 1.7, 1.8, 4.5_

- [ ] 3.2 (P) Implement the transaction state machine with transition rules
  - Implement state transition validation logic: only allowed transitions are (new)→PENDING, (new)→APPROVED, (new)→DECLINED, PENDING→APPROVED, PENDING→DECLINED, APPROVED→VOIDED, APPROVED→SETTLED
  - Ensure that VOIDED, SETTLED, and DECLINED are terminal states that reject further transitions
  - Ensure that PENDING can only resolve to APPROVED or DECLINED
  - _Requirements: 3.1, 3.2_

- [ ] 4. Authentication and authorization middleware
- [ ] 4.1 (P) Implement JWT verification and claims extraction
  - Implement RS256 signature verification using the configured public key loaded from environment variable at startup; fail-fast if the key is missing or malformed
  - Validate `exp` and `iss` claims on every token; reject HS256 tokens
  - Extract `merchantId`, `terminalId`, and `scopes` from JWT claims and populate an `AuthContext` on the request object for downstream components
  - Return HTTP 401 for missing, expired, or malformed tokens
  - Mount the middleware as a Fastify `onRequest` hook on all routes except `GET /health`
  - _Requirements: 6.1, 6.2_

- [ ] 4.2 (P) Implement scope enforcement and merchant account status checks
  - Implement a `requireScope(scope)` pre-handler factory that reads the `AuthContext.scopes` array and returns HTTP 403 if the required scope is absent
  - Implement an account status check that returns HTTP 403 with an account status reason when `accountStatus` is `INACTIVE` or `SUSPENDED`
  - Ensure all repository queries downstream receive the `merchantId` from the verified JWT claims, never from the request body, enforcing tenant isolation
  - _Requirements: 6.3, 6.4, 6.5_

- [ ] 5. Idempotency store and middleware
- [ ] 5.1 (P) Implement the Redis-backed idempotency store with distributed locking
  - Implement key lookup using Redis: store each idempotency record as a Redis Hash with fields `response`, `fingerprint`, and `createdAt`
  - Use `SET key value EX 86400 NX` atomically to prevent overwrites and enforce the 24-hour TTL
  - Implement Redlock-based distributed lock acquisition on `lock:{idempotencyKey}` with a 10-second lock TTL before any new processing begins
  - Return the locked resource handle for the middleware to release after processing completes
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 5.2 (P) Implement the Fastify idempotency pre-handler for POST /transactions
  - Apply the pre-handler exclusively to the `POST /transactions` route
  - On cache hit: deserialize the stored response, inject `Idempotent-Replayed: true` response header, and return the original response without reaching the domain layer
  - On concurrent duplicate (lock cannot be acquired): return HTTP 409
  - After successful processing, persist the serialized response to the store with the idempotency key
  - Implement a safe-mode fallback: if Redis is unavailable, skip idempotency checking, log a warning, and allow the request to proceed (document degraded-mode behavior)
  - _Requirements: 7.1, 7.2, 7.4_

- [ ] 6. Acquirer adapter with circuit breaker
- [ ] 6.1 (P) Implement the acquirer HTTP client with timeout and trace context
  - Implement outbound HTTP calls to the acquirer REST API using undici with a configured timeout of 25 seconds (leaving 5 s margin below the 30 s SLA)
  - Serialize `AuthorizeCommand` to the acquirer-specific request format and deserialize acquirer responses into a typed `AcquirerResult` discriminated union (APPROVED / DECLINED / TIMEOUT / ERROR)
  - Propagate W3C Trace-Context headers on all outbound acquirer calls
  - Load acquirer base URL and credentials exclusively from environment variables; never hardcode them
  - _Requirements: 1.1, 1.6, 8.2_

- [ ] 6.2 (P) Wrap acquirer calls with Opossum circuit breaker
  - Configure the Opossum circuit breaker: timeout 25 s, `errorThresholdPercentage` 50%, `resetTimeout` 30 s
  - On timeout, produce a typed `AcquirerResult { outcome: 'TIMEOUT' }` — never allow the circuit to throw an untyped error to the domain layer
  - On circuit open (breaker tripped), return a structured `CIRCUIT_OPEN` error that maps to HTTP 503 with a `Retry-After` header
  - Integrate opossum-prometheus to emit OTel metrics for circuit state changes (open/half-open/closed)
  - _Requirements: 1.6, 3.4_

- [ ] 7. Transaction repository
- [ ] 7.1 (P) Implement transaction persistence and retrieval operations
  - Implement `create(data)` to insert a new transaction record; include `merchantId` from JWT claims as a mandatory field
  - Implement `findById(id, merchantId)` with a mandatory `WHERE merchant_id = $merchantId` filter; return `null` (not an error) when no record is found to allow the service layer to return HTTP 404
  - Implement `updateStatus(id, status, metadata)` using Prisma's optimistic locking via the `version` field to prevent concurrent state corruption
  - _Requirements: 1.4, 1.5, 1.6, 2.1, 2.2, 3.1, 3.3_

- [ ] 7.2 (P) Implement transaction listing and reconciliation query operations
  - Implement `list(filters)` supporting pagination and filtering by `terminalId`, `status`, and date range (`dateFrom`, `dateTo`); all queries must include `WHERE merchant_id = $merchantId`
  - Implement `listForReconciliation(query)` returning only `APPROVED` and `VOIDED` transactions for the given merchant, optional terminal, and date range; include all fields required for reconciliation records
  - Return paginated results as `{ items, total, page, pageSize }`
  - _Requirements: 2.3, 2.4, 2.5, 5.1, 5.4_

- [ ] 8. Audit log repository
- [ ] 8.1 (P) Implement append-only audit log persistence with non-blocking failure handling
  - Implement `write(entry)` to insert audit entries into the `audit_entries` table; the entry captures actor identity, action type, resource ID, outcome, timestamp, and metadata
  - Wrap the write operation in a fire-and-forget pattern: `write()` must never reject to its caller regardless of persistence outcome
  - On write failure, emit a critical-level OTel metric `audit_log_write_failures_total` and log at `error` level with correlation context
  - _Requirements: 8.3, 8.4_

- [ ] 9. Transaction service: authorization lifecycle
- [ ] 9.1 Implement input validation and merchant/terminal ownership verification
  - Validate all `AuthorizeCommand` fields: amount must be a positive integer, currency must match the ISO 4217 allowlist, all required fields (amount, currency, paymentMethod type, terminalId, merchantId) must be present
  - Verify that the terminal belongs to the merchant extracted from the JWT claims before forwarding to the acquirer
  - Return HTTP 422 with a structured error response listing each invalid field when validation fails
  - _Requirements: 1.2, 1.3_

- [ ] 9.2 Implement authorization orchestration with acquirer integration
  - Call the Acquirer Adapter `authorize()` within a 25 s timeout envelope; map the `AcquirerResult` outcome to the appropriate transaction status: APPROVED → HTTP 201, DECLINED → HTTP 200, TIMEOUT → HTTP 202 / PENDING
  - Persist the transaction record and the audit log entry atomically within a single Prisma database transaction to guarantee consistency
  - Normalize all acquirer error details into typed error envelopes before returning to callers; never expose raw acquirer messages
  - _Requirements: 1.1, 1.4, 1.5, 1.6_

- [ ] 9.3 Implement transaction status query and PENDING resolution
  - Implement `getById(transactionId, merchantId)`: return the full transaction record including status, timestamps, and authorization code; return HTTP 404 for unknown or cross-tenant IDs
  - For `PENDING` transactions, include the timestamp of the last acquirer status check in the response
  - Implement a PENDING resolution path: when `getById` is called on a PENDING transaction, trigger an acquirer re-check and update the status to the resolved outcome before returning the response
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 9.4 Implement paginated transaction listing with filters
  - Implement `list(filters)` accepting `terminalId`, date range, and `status` as optional filters; enforce pagination via `page` and `pageSize` parameters
  - All list queries must be scoped to the authenticated merchant's ID
  - _Requirements: 2.5_

- [ ] 10. Void service
- [ ] 10.1 (P) Implement void eligibility validation and acquirer void call
  - Load the target transaction by ID; assert that status is exactly `APPROVED` and that the record is not in a settled state before proceeding
  - Return HTTP 409 if the current status is `VOIDED`, `SETTLED`, or `DECLINED`; include the current status in the error response
  - Call the Acquirer Adapter `void()` with the authorization code; on acquirer rejection return HTTP 422 with the acquirer rejection reason while leaving the original transaction status unchanged
  - _Requirements: 3.1, 3.2, 3.4_

- [ ] 10.2 (P) Implement void confirmation: status update, operator recording, and audit log
  - On acquirer confirmation, update the transaction status to `VOIDED` and record `voidedAt` timestamp and `voidedBy` operator identity
  - Write an audit log entry capturing the operator ID, action `VOID`, transaction ID, outcome, and timestamp
  - Apply the `transactions:void` scope guard so that only callers with that permission can reach this endpoint
  - _Requirements: 3.3, 3.5, 8.3_

- [ ] 11. Receipt service
- [ ] 11.1 (P) Implement receipt composition with PAN masking and template support
  - Assert that the target transaction status is `APPROVED` or `VOIDED` before composing the receipt; return HTTP 409 for `DECLINED` or `PENDING` transactions
  - Build the `ReceiptPayload` with: transactionId, merchantName, terminalId, amount, currency, paymentMethodType, maskedPan (last 4 digits, e.g. `****1234`), authorizationCode, and transactionTimestamp
  - Apply the merchant's configured receipt template if one is set in `MerchantConfig.receiptTemplateId`; fall back to the default template otherwise
  - Return the receipt as a JSON payload
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 12. Reconciliation service and async export job queue
- [ ] 12.1 Implement synchronous reconciliation report endpoint
  - Validate that the requested date range does not exceed 31 days; return HTTP 400 with a clear message if it does
  - Query the Transaction Repository for all `APPROVED` and `VOIDED` transactions matching the merchant, optional terminal, and date range
  - Compute totals by `paymentMethodType` (sum of amounts in cents) and include them in the `ReconciliationSummary` alongside the individual records
  - Each record must include: transactionId, amount, currency, paymentMethodType, authorizationCode, settlementStatus, and acquirerReferenceNumber
  - Apply the `reconciliation:read` scope guard to this endpoint
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 12.2 Implement asynchronous reconciliation export job creation and polling
  - When the estimated result set exceeds the configurable threshold (default: 10,000 records), enqueue a BullMQ job with the `ReconciliationQuery` as job data instead of returning inline results
  - Return a `ReconciliationJob` with `jobId` and `status: QUEUED` immediately on job creation; the terminal can poll using `GET /reconciliation/jobs/{id}`
  - Implement the BullMQ worker that processes the job, writes results to a signed storage URL, and updates the job record to `COMPLETED` with `resultUrl`
  - Deduplicate job submissions for the same query within 1 hour by hashing the query parameters into a job name
  - Apply the `reconciliation:read` scope guard to both the job creation and polling endpoints
  - _Requirements: 5.2, 5.5_

- [ ] 13. HTTP routes and full API layer wiring
- [ ] 13.1 Register all API routes with Fastify JSON schema validation
  - Register `POST /v1/transactions` with JSON schema for the request body (amount as integer, currency, paymentMethod, terminalId, merchantId; `Idempotency-Key` header required); configure `additionalProperties: false` on all schemas to reject unexpected fields
  - Register `GET /v1/transactions` (paginated list) and `GET /v1/transactions/{id}` with filter parameter schemas
  - Register `POST /v1/transactions/{id}/void` with the `transactions:void` scope guard
  - Register `GET /v1/transactions/{id}/receipt`
  - Register `GET /v1/reconciliation`, `POST /v1/reconciliation/jobs`, and `GET /v1/reconciliation/jobs/{id}` all with the `reconciliation:read` scope guard
  - Register `GET /health` without authentication middleware; return `{ status: "ok", uptime: number }`
  - _Requirements: 1.2, 1.3, 3.5, 4.3, 5.2, 6.1, 8.5_

- [ ] 13.2 Implement the centralized error serializer
  - Map all typed domain errors (`TransactionError`, `VoidError`, `ReceiptError`, `ReconciliationError`, `AuthError`, `IdempotencyError`, `AcquirerAdapterError`) to the correct HTTP status codes and structured response bodies
  - For 422 responses, serialize the `fields` array as `{ errors: [{ field, message }] }`
  - For 5xx responses, include the correlation ID in the response body but never expose stack traces or internal error details
  - For 503 responses from an open circuit breaker, include a `Retry-After` header
  - _Requirements: 1.3, 3.2, 3.4, 4.2, 5.3, 6.2, 6.3, 6.5, 7.2_

- [ ] 14. Observability: structured logging and OpenTelemetry tracing
- [ ] 14.1 (P) Implement structured JSON request/response logging with Pino
  - Configure Pino as the Fastify logger with structured JSON output
  - Add `onRequest` and `onResponse` Fastify lifecycle hooks to emit one log entry per inbound request and outbound response, including: correlation ID, merchantId, terminalId, operation type, HTTP status, and end-to-end latency
  - Log all 4xx responses at `warn` level and 5xx responses at `error` level, including `correlationId`, `route`, and `statusCode`
  - _Requirements: 8.1_

- [ ] 14.2 (P) Configure OpenTelemetry SDK and trace context propagation
  - Initialize the `@opentelemetry/sdk-node` auto-instrumentation at service startup to instrument Fastify, Prisma, and ioredis spans automatically
  - Configure the Acquirer Adapter to inject W3C Trace-Context headers (`traceparent`, `tracestate`) on every outbound HTTP call so traces span across service boundaries
  - Ensure each authorization, void, and reconciliation operation creates an OTel span; acquirer calls create child spans of the parent request span
  - _Requirements: 8.2_

- [ ] 15. Unit tests for domain services and infrastructure components
- [ ] 15.1 (P) Write unit tests for Transaction Service authorization outcomes
  - Test `authorize()` for APPROVED outcome: correct status, HTTP 201, audit log written
  - Test `authorize()` for DECLINED outcome: correct status, HTTP 200, decline code recorded
  - Test `authorize()` for TIMEOUT/PENDING outcome: correct status, HTTP 202
  - Test validation rejection: missing required fields return 422 with structured field errors
  - Test PAN masking: `MaskedPan` value object rejects full PANs and only accepts last-4 format
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.5_

- [ ] 15.2 (P) Write unit tests for Void Service state transitions
  - Test eligible void: APPROVED transaction → acquirer confirmation → status VOIDED, voidedAt and voidedBy recorded
  - Test ineligible states: VOIDED, SETTLED, and DECLINED transactions each return HTTP 409
  - Test acquirer rejection: original status unchanged, HTTP 422 returned with reason
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 15.3 (P) Write unit tests for Idempotency Middleware
  - Test cache hit: returns the stored response with `Idempotent-Replayed: true` header without calling the domain service
  - Test concurrent duplicate: when Redlock cannot be acquired, returns HTTP 409
  - Test expired key: treated as a cache miss, new processing proceeds normally
  - _Requirements: 7.1, 7.2, 7.4_

- [ ] 15.4 (P) Write unit tests for Acquirer Adapter circuit breaker behavior
  - Test circuit breaker trip: after exceeding the error threshold, subsequent calls return `CIRCUIT_OPEN` without calling the acquirer
  - Test timeout handling: acquirer call exceeding 25 s produces `AcquirerResult { outcome: 'TIMEOUT' }` without throwing
  - Test W3C trace header propagation: outbound acquirer requests include `traceparent` and `tracestate` headers
  - _Requirements: 1.6, 8.2_

- [ ] 16. Integration tests for full API flows
- [ ] 16.1 (P) Test the full authorization flow end-to-end
  - Test `POST /v1/transactions` APPROVED: request → acquirer stub → PostgreSQL persistence → audit log entry created → idempotency key stored in Redis → 201 response
  - Test DECLINED flow: 200 response with decline code
  - Test PENDING flow: acquirer stub timeout → 202 response → subsequent `GET /v1/transactions/{id}` reflects PENDING with last-check timestamp
  - Test idempotency replay: second request with same `Idempotency-Key` returns original response with `Idempotent-Replayed: true` without creating a new transaction
  - _Requirements: 1.1, 1.4, 1.5, 1.6, 7.1, 7.4_

- [ ] 16.2 (P) Test void and receipt flows end-to-end
  - Test `POST /v1/transactions/{id}/void`: APPROVED transaction → acquirer void confirmation → status VOIDED, voidedAt/voidedBy recorded
  - Test void state guards: VOIDED, SETTLED, and DECLINED transactions each return 409
  - Test `GET /v1/transactions/{id}/receipt` for APPROVED and VOIDED transactions: correct ReceiptPayload with masked PAN
  - Test receipt unavailability: DECLINED and PENDING transactions return 409
  - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.5_

- [ ] 16.3 (P) Test authentication, authorization, and tenant isolation
  - Test missing JWT: returns 401 on all protected endpoints
  - Test valid JWT without required scope: `transactions:void` and `reconciliation:read` endpoints return 403
  - Test suspended merchant account: returns 403 with account status reason
  - Test cross-tenant isolation: merchant A cannot access transactions belonging to merchant B
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 16.4 (P) Test reconciliation endpoint and async export jobs
  - Test `GET /v1/reconciliation` with valid date range: returns APPROVED and VOIDED transactions with totals by payment method
  - Test date range exceeding 31 days: returns 400
  - Test `POST /v1/reconciliation/jobs`: job created and polled to COMPLETED via `GET /v1/reconciliation/jobs/{id}`
  - Test concurrent idempotency: two simultaneous `POST /v1/transactions` requests with the same `Idempotency-Key` → one 201, one 409
  - _Requirements: 5.1, 5.3, 5.5, 7.2_

- [ ] 17. Performance validation
- [ ] 17.1 Validate authorization endpoint latency under load
  - Run a load test with 100 concurrent requests against the authorization endpoint using an acquirer stub responding in 1 s; verify P95 latency ≤ 5 s
  - Measure idempotency key Redis lookup overhead; verify it adds ≤ 5 ms P99 latency per request
  - _Requirements: 1.1_

- [ ] 17.2* Validate reconciliation query performance thresholds
  - Verify that a synchronous reconciliation query over a 10,000-record result set completes within 3 s
  - Verify that when the threshold is exceeded, the async job is dispatched and acknowledged within 500 ms
  - _Requirements: 5.5_
