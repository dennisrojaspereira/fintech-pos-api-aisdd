/**
 * Centralized error serializer + Fastify global error handler.
 *
 * Implementa requirements 1.3, 3.2, 3.4, 4.2, 5.3, 6.2, 6.3, 6.5, 7.2.
 *
 * Mapeia erros tipados (TransactionError, VoidError, ReceiptError,
 * ReconciliationError, AuthError, IdempotencyError, AcquirerAdapterError) para
 * respostas HTTP coerentes com o design.md ("Error Strategy"):
 *
 *   - 422 VALIDATION_ERROR → `{ errors: [{field,message}] }` (req 1.3).
 *   - 404 NOT_FOUND        → `{ error: { code } }`.
 *   - 409 NOT_ELIGIBLE / NOT_AVAILABLE → `{ error: { code, currentStatus } }`.
 *   - 422 ACQUIRER_REJECTED → `{ error: { code, reason } }` (req 3.4).
 *   - 503 CIRCUIT_OPEN     → header `Retry-After`.
 *   - 400 DATE_RANGE_EXCEEDED → `{ error: { code, maxDays } }` (req 5.3).
 *   - 401 TOKEN_*          → 401 (req 6.2).
 *   - 403 SCOPE_MISSING / ACCOUNT_* → 403 (req 6.3, 6.5).
 *   - 409 CONCURRENT_REQUEST → 409 (req 7.2).
 *   - 503 STORE_UNAVAILABLE → 503.
 *   - 500 INTERNAL_ERROR / SERIALIZATION_ERROR / unknown → 500 com
 *     `correlationId` (req 8.1). NUNCA expõe stack ou erro cru.
 *
 * O caso `ACQUIRER_TIMEOUT` (HTTP 202) NÃO é um erro: é um success path
 * (transação persistida como PENDING). Os route handlers não devem mapeá-lo
 * via este serializer — o `transactionService.authorize` já encapsula esse
 * caminho dentro de `Result.ok` (status PENDING). Mantemos um branch defensivo
 * que retorna 202 com payload mínimo se chegar aqui inesperadamente, mas o
 * caminho normal é o handler responder 202 diretamente.
 */

import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import type {
  AuthError,
  TransactionError,
  VoidError,
  ReceiptError,
  ReconciliationError,
  IdempotencyError,
  AcquirerAdapterError,
  FieldError,
} from '../../shared/types.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * União dos tipos de erro de domínio que aceitam `mapErrorToResponse`.
 * Note que ACQUIRER_TIMEOUT (httpStatus 202) está incluído defensivamente —
 * o handler convencional usa o success path em vez do serializer.
 */
export type TypedDomainError =
  | AuthError
  | TransactionError
  | VoidError
  | ReceiptError
  | ReconciliationError
  | IdempotencyError
  | AcquirerAdapterError;

/** Resultado serializado pronto para `reply.code(...).send(...)`. */
export interface SerializedErrorResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

// ─────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────

/**
 * Verifica se um valor é um `TypedDomainError` da fonte única
 * `src/shared/types.ts` (presença de `code` string + `httpStatus` numérico).
 */
export function isTypedDomainError(value: unknown): value is TypedDomainError {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { code?: unknown; httpStatus?: unknown };
  return typeof v.code === 'string' && typeof v.httpStatus === 'number';
}

/**
 * Erro Fastify de validação de schema (AJV → statusCode 400 + `validation` array).
 * Tratamos como 422 conforme req 1.3.
 */
function isFastifyValidationError(error: unknown): error is FastifyError {
  if (error === null || typeof error !== 'object') return false;
  const e = error as FastifyError;
  return (
    e.statusCode === 400 &&
    Array.isArray((e as { validation?: unknown }).validation)
  );
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Mapeia um erro tipado de domínio em um `SerializedErrorResponse`. Use
 * dentro dos route handlers (após um `Result.err`) ou via `setErrorHandler`.
 */
export function mapErrorToResponse(
  error: TypedDomainError,
): SerializedErrorResponse {
  switch (error.code) {
    // ── 422 VALIDATION_ERROR (req 1.3)
    case 'VALIDATION_ERROR': {
      const fields: readonly FieldError[] = error.fields ?? [];
      return {
        status: 422,
        body: {
          errors: fields.map((f) => ({
            field: f.field,
            message: f.message,
          })),
        },
      };
    }

    // ── 404 NOT_FOUND (req 2.2, 4.2 fallback)
    case 'NOT_FOUND':
      return {
        status: 404,
        body: { error: { code: 'NOT_FOUND' } },
      };

    // ── 409 NOT_ELIGIBLE (req 3.2)
    case 'NOT_ELIGIBLE':
      return {
        status: 409,
        body: {
          error: {
            code: 'NOT_ELIGIBLE',
            currentStatus: error.currentStatus,
          },
        },
      };

    // ── 409 NOT_AVAILABLE (req 4.2)
    case 'NOT_AVAILABLE':
      return {
        status: 409,
        body: {
          error: {
            code: 'NOT_AVAILABLE',
            currentStatus: error.currentStatus,
          },
        },
      };

    // ── 422 ACQUIRER_REJECTED (req 3.4)
    case 'ACQUIRER_REJECTED':
      return {
        status: 422,
        body: {
          error: {
            code: 'ACQUIRER_REJECTED',
            reason: error.reason,
          },
        },
      };

    // ── 202 ACQUIRER_TIMEOUT (req 1.6) — defensive branch.
    case 'ACQUIRER_TIMEOUT':
      return {
        status: 202,
        body: {
          status: 'PENDING',
        },
      };

    // ── 503 CIRCUIT_OPEN com Retry-After (req design.md "Error Strategy")
    case 'CIRCUIT_OPEN':
      return {
        status: 503,
        body: { error: { code: 'CIRCUIT_OPEN' } },
        headers: { 'Retry-After': String(error.retryAfterSeconds) },
      };

    // ── 400 DATE_RANGE_EXCEEDED (req 5.3)
    case 'DATE_RANGE_EXCEEDED':
      return {
        status: 400,
        body: {
          error: {
            code: 'DATE_RANGE_EXCEEDED',
            maxDays: error.maxDays,
          },
        },
      };

    // ── 401 TOKEN_* (req 6.2)
    case 'TOKEN_MISSING':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_INVALID':
      return {
        status: 401,
        body: { error: { code: error.code } },
      };

    // ── 403 SCOPE_MISSING / ACCOUNT_* (req 6.3, 6.5)
    case 'SCOPE_MISSING':
    case 'ACCOUNT_SUSPENDED':
    case 'ACCOUNT_INACTIVE':
      return {
        status: 403,
        body: {
          error: {
            code: error.code,
            ...(error.reason !== undefined ? { reason: error.reason } : {}),
          },
        },
      };

    // ── 403 FORBIDDEN — usado pelo ReconciliationError genérico
    case 'FORBIDDEN':
      return {
        status: 403,
        body: { error: { code: 'FORBIDDEN' } },
      };

    // ── 409 CONCURRENT_REQUEST (req 7.2)
    case 'CONCURRENT_REQUEST':
      return {
        status: 409,
        body: { error: { code: 'CONCURRENT_REQUEST' } },
      };

    // ── 503 STORE_UNAVAILABLE
    case 'STORE_UNAVAILABLE':
      return {
        status: 503,
        body: { error: { code: 'STORE_UNAVAILABLE' } },
      };

    // ── 500 INTERNAL_ERROR / SERIALIZATION_ERROR
    case 'INTERNAL_ERROR':
    case 'SERIALIZATION_ERROR':
      return {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR' } },
      };

    default: {
      // Exhaustiveness check — se o switch ficar incompleto, o TS quebra aqui.
      const _exhaustive: never = error;
      void _exhaustive;
      return {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR' } },
      };
    }
  }
}

/**
 * Resolve correlation id pelo mesmo método do request-logger (header
 * X-Correlation-Id ou request.id).
 */
function correlationIdFor(request: FastifyRequest): string {
  const headerVal = request.headers['x-correlation-id'];
  if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  if (Array.isArray(headerVal) && headerVal.length > 0) {
    const first = headerVal[0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  return request.id;
}

/**
 * Constrói o body 5xx adicionando `correlationId` para investigação.
 */
function withCorrelationId(
  base: { error: { code: string } },
  correlationId: string,
): unknown {
  return {
    error: {
      ...base.error,
      correlationId,
    },
  };
}

/**
 * Adapta um `FastifyError` de validação de schema (AJV) para o formato
 * `VALIDATION_ERROR` (req 1.3). Cada item do `validation[]` vira um
 * `{ field, message }`.
 */
function buildValidationErrorBody(
  error: FastifyError,
): SerializedErrorResponse {
  const validation = (error as { validation?: readonly unknown[] }).validation;
  const errors: Array<{ field: string; message: string }> = [];
  if (Array.isArray(validation)) {
    for (const item of validation) {
      if (item === null || typeof item !== 'object') continue;
      const v = item as {
        instancePath?: string;
        schemaPath?: string;
        params?: { missingProperty?: string };
        message?: string;
      };
      const path = v.instancePath ?? '';
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const field =
        cleanPath.length > 0
          ? cleanPath.replace(/\//g, '.')
          : v.params?.missingProperty ?? 'request';
      errors.push({
        field,
        message: v.message ?? 'invalid',
      });
    }
  }
  if (errors.length === 0) {
    errors.push({ field: 'request', message: error.message ?? 'invalid' });
  }
  return {
    status: 422,
    body: { errors },
  };
}

/**
 * Aplica os headers (se houver) e responde com status + body.
 */
function sendSerializedResponse(
  reply: FastifyReply,
  serialized: SerializedErrorResponse,
): void {
  if (serialized.headers) {
    for (const [name, value] of Object.entries(serialized.headers)) {
      void reply.header(name, value);
    }
  }
  void reply.code(serialized.status).send(serialized.body);
}

/**
 * Registra o handler global de erros do Fastify.
 *
 * Fluxo (em ordem):
 *   1. Erros de validação de schema (AJV) → 422 VALIDATION_ERROR (req 1.3).
 *   2. Erros de domínio (TypedDomainError) → `mapErrorToResponse`.
 *   3. Erros desconhecidos → 500 com correlationId. NUNCA expõe stack.
 *
 * Logging:
 *   - 5xx → `request.log.error`
 *   - 4xx → `request.log.warn`
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = correlationIdFor(request);

    // 1) Schema validation (AJV) → 422.
    if (isFastifyValidationError(error)) {
      const serialized = buildValidationErrorBody(error);
      request.log.warn(
        {
          event: 'http.error',
          correlationId,
          httpStatus: serialized.status,
          code: 'VALIDATION_ERROR',
        },
        'schema validation failed',
      );
      sendSerializedResponse(reply, serialized);
      return;
    }

    // 2) Erro tipado de domínio.
    if (isTypedDomainError(error)) {
      const serialized = mapErrorToResponse(error);

      // 5xx → carrega correlationId no body.
      if (serialized.status >= 500) {
        const body = serialized.body as { error?: { code?: string } };
        const enriched = withCorrelationId(
          {
            error: { code: body?.error?.code ?? 'INTERNAL_ERROR' },
          },
          correlationId,
        );
        request.log.error(
          {
            event: 'http.error',
            correlationId,
            httpStatus: serialized.status,
            code: error.code,
          },
          'domain error → 5xx',
        );
        sendSerializedResponse(reply, {
          status: serialized.status,
          body: enriched,
          ...(serialized.headers ? { headers: serialized.headers } : {}),
        });
        return;
      }

      // 4xx
      request.log.warn(
        {
          event: 'http.error',
          correlationId,
          httpStatus: serialized.status,
          code: error.code,
        },
        'domain error → 4xx',
      );
      sendSerializedResponse(reply, serialized);
      return;
    }

    // 3) Erro desconhecido → 500. Nunca expõe stack/raw error.
    request.log.error(
      {
        event: 'http.error',
        correlationId,
        httpStatus: 500,
        // `err` é serializado pelo Pino, sem vazar stack para a resposta.
        err: error,
      },
      'unhandled error',
    );
    sendSerializedResponse(reply, {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          correlationId,
        },
      },
    });
  });
}
