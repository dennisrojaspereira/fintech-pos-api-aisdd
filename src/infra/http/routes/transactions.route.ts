/**
 * Routes — /v1/transactions.
 *
 * Implementa requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.5, 6.4,
 * 7.1 (idempotency) e 8.5 (health já é separado).
 *
 * Endpoints:
 *   - POST   /v1/transactions          — autoriza nova transação.
 *   - GET    /v1/transactions          — lista paginada com filtros.
 *   - GET    /v1/transactions/:id      — busca por id.
 *
 * Observações de design:
 *   - `additionalProperties: false` em TODO request/response schema (defesa
 *     em profundidade contra payloads inesperados).
 *   - `merchantId` é SEMPRE extraído de `request.authContext.merchantId`
 *     (claims do JWT). Se o body envia `merchantId` divergente do claim,
 *     respondemos 422 — req 6.4 + design.md "Tenant isolation".
 *   - O preHandler de idempotência é amarrado por `registerIdempotencyForRoute`
 *     no plugin pai (server.ts) — aqui apenas declaramos o `headers` schema
 *     que torna `Idempotency-Key` obrigatório (req 7.1).
 *   - Erros de domínio são retornados via `Result.err` e re-lançados como
 *     `TypedDomainError` para o `setErrorHandler` global serializar.
 */

import type { FastifyInstance } from 'fastify';
import { TransactionStatus } from '../../../shared/enums.js';
import type {
  AuthorizeCommand,
  TransactionListFilters,
  TransactionRecord,
} from '../../../shared/types.js';
import { transactionService } from '../../../domain/transaction/transaction.service.js';
import { requireActiveAccount } from '../middleware/scope.js';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const paymentMethodSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'maskedPan', 'expiryMonth', 'expiryYear'],
  properties: {
    type: {
      type: 'string',
      enum: ['CREDIT_CARD', 'DEBIT_CARD', 'CONTACTLESS_NFC'],
    },
    maskedPan: { type: 'string', minLength: 1 },
    expiryMonth: { type: 'integer', minimum: 1, maximum: 12 },
    expiryYear: { type: 'integer', minimum: 2000, maximum: 2100 },
  },
} as const;

const authorizeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'currency', 'paymentMethod', 'terminalId'],
  properties: {
    amount: { type: 'integer', minimum: 1 },
    currency: { type: 'string', minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$' },
    paymentMethod: paymentMethodSchema,
    terminalId: { type: 'string', minLength: 1 },
    /** merchantId é OPCIONAL no body — se enviado, deve bater com o claim. */
    merchantId: { type: 'string', minLength: 1 },
  },
} as const;

const idempotencyHeaderSchema = {
  type: 'object',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': { type: 'string', minLength: 1 },
  },
} as const;

const transactionResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId', 'status', 'createdAt', 'updatedAt'],
  properties: {
    transactionId: { type: 'string' },
    status: {
      type: 'string',
      enum: ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'SETTLED'],
    },
    authorizationCode: { type: ['string', 'null'] },
    acquirerDeclineCode: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const errorEnvelopeSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
      },
    },
    errors: { type: 'array' },
  },
} as const;

const transactionRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'merchantId',
    'terminalId',
    'amount',
    'currency',
    'paymentMethodType',
    'maskedPan',
    'status',
    'createdAt',
    'updatedAt',
    'version',
  ],
  properties: {
    id: { type: 'string' },
    merchantId: { type: 'string' },
    terminalId: { type: 'string' },
    amount: { type: 'integer' },
    currency: { type: 'string' },
    paymentMethodType: {
      type: 'string',
      enum: ['CREDIT_CARD', 'DEBIT_CARD', 'CONTACTLESS_NFC'],
    },
    maskedPan: { type: 'string' },
    status: {
      type: 'string',
      enum: ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'SETTLED'],
    },
    authorizationCode: { type: ['string', 'null'] },
    acquirerReferenceNumber: { type: ['string', 'null'] },
    acquirerDeclineCode: { type: ['string', 'null'] },
    voidedBy: { type: ['string', 'null'] },
    voidedAt: { type: ['string', 'null'] },
    lastAcquirerCheckAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    version: { type: 'integer' },
  },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    terminalId: { type: 'string', minLength: 1 },
    status: {
      type: 'string',
      enum: ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'SETTLED'],
    },
    dateFrom: { type: 'string', format: 'date-time' },
    dateTo: { type: 'string', format: 'date-time' },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

// ─────────────────────────────────────────────
// Types (JSON Schema → TS)
// ─────────────────────────────────────────────

interface AuthorizeBody {
  amount: number;
  currency: string;
  paymentMethod: {
    type: 'CREDIT_CARD' | 'DEBIT_CARD' | 'CONTACTLESS_NFC';
    maskedPan: string;
    expiryMonth: number;
    expiryYear: number;
  };
  terminalId: string;
  merchantId?: string;
}

interface ListQuery {
  terminalId?: string;
  status?: TransactionStatus;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

interface IdParams {
  id: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Mapeia status do TransactionResult para HTTP code de criação:
 *   - APPROVED → 201
 *   - DECLINED → 200
 *   - PENDING  → 202 (req 1.6 — acquirer timeout)
 *   - VOIDED/SETTLED → 200 (não esperado neste endpoint, mas defensivo)
 */
function statusToHttpCode(status: TransactionStatus): number {
  switch (status) {
    case TransactionStatus.APPROVED:
      return 201;
    case TransactionStatus.PENDING:
      return 202;
    case TransactionStatus.DECLINED:
    case TransactionStatus.VOIDED:
    case TransactionStatus.SETTLED:
    default:
      return 200;
  }
}

/**
 * Serializa um TransactionRecord conforme o response schema. Mantém os
 * campos opcionais como `null` (em vez de omitir) para casar com o
 * schema declarado.
 */
function serializeRecord(record: TransactionRecord): Record<string, unknown> {
  return {
    id: record.id,
    merchantId: record.merchantId,
    terminalId: record.terminalId,
    amount: record.amount,
    currency: record.currency,
    paymentMethodType: record.paymentMethodType,
    maskedPan: record.maskedPan,
    status: record.status,
    authorizationCode: record.authorizationCode,
    acquirerReferenceNumber: record.acquirerReferenceNumber,
    acquirerDeclineCode: record.acquirerDeclineCode,
    voidedBy: record.voidedBy,
    voidedAt: record.voidedAt,
    lastAcquirerCheckAt: record.lastAcquirerCheckAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
  };
}

// ─────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────

/**
 * Plugin Fastify que registra as rotas de transação. Deve ser registrado
 * dentro de um `app.register(..., { prefix: '/v1' })`. O caller é também
 * responsável por aplicar `requireActiveAccount` (auth ativa) — usamos
 * preHandler local em todas as rotas para defesa em profundidade.
 */
export async function transactionsRoute(app: FastifyInstance): Promise<void> {
  // ── POST /transactions
  app.post<{ Body: AuthorizeBody }>(
    '/transactions',
    {
      preHandler: [requireActiveAccount],
      schema: {
        description: 'Submit transaction authorization (req 1.1, 7.1).',
        tags: ['transactions'],
        headers: idempotencyHeaderSchema,
        body: authorizeBodySchema,
        response: {
          200: transactionResultSchema,
          201: transactionResultSchema,
          202: transactionResultSchema,
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
          500: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        // Defense-in-depth — auth onRequest já deveria ter bloqueado.
        throw { code: 'TOKEN_MISSING', httpStatus: 401 };
      }

      const body = request.body;

      // Tenant isolation: se body envia merchantId, deve bater com claim.
      if (body.merchantId !== undefined && body.merchantId !== ctx.merchantId) {
        throw {
          code: 'VALIDATION_ERROR',
          httpStatus: 422,
          fields: [
            {
              field: 'merchantId',
              message: 'merchantId in body does not match authenticated merchant',
            },
          ],
        };
      }

      const idempotencyKey = String(request.headers['idempotency-key']);

      const cmd: AuthorizeCommand = {
        merchantId: ctx.merchantId,
        terminalId: body.terminalId,
        amount: body.amount,
        currency: body.currency,
        paymentMethod: {
          type: body.paymentMethod.type,
          maskedPan: body.paymentMethod.maskedPan,
          expiryMonth: body.paymentMethod.expiryMonth,
          expiryYear: body.paymentMethod.expiryYear,
        },
        idempotencyKey,
      };

      const result = await transactionService.authorize(cmd);
      if (!result.ok) {
        // Lança o erro tipado para o `setErrorHandler` global serializar.
        throw result.error;
      }

      const httpCode = statusToHttpCode(result.value.status);
      void reply.code(httpCode).send({
        transactionId: result.value.transactionId,
        status: result.value.status,
        authorizationCode: result.value.authorizationCode,
        acquirerDeclineCode: result.value.acquirerDeclineCode,
        createdAt: result.value.createdAt,
        updatedAt: result.value.updatedAt,
      });
    },
  );

  // ── GET /transactions
  app.get<{ Querystring: ListQuery }>(
    '/transactions',
    {
      preHandler: [requireActiveAccount],
      schema: {
        description: 'List transactions with filters (req 2.5).',
        tags: ['transactions'],
        querystring: listQuerySchema,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'total', 'page', 'pageSize'],
            properties: {
              items: { type: 'array', items: transactionRecordSchema },
              total: { type: 'integer' },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
            },
          },
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
          500: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        throw { code: 'TOKEN_MISSING', httpStatus: 401 };
      }

      const q = request.query;

      const filters: TransactionListFilters = {
        merchantId: ctx.merchantId,
        ...(q.terminalId !== undefined ? { terminalId: q.terminalId } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.dateFrom !== undefined
          ? { dateFrom: new Date(q.dateFrom) }
          : {}),
        ...(q.dateTo !== undefined ? { dateTo: new Date(q.dateTo) } : {}),
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      };

      const result = await transactionService.list(filters);
      if (!result.ok) {
        throw result.error;
      }

      void reply.code(200).send({
        items: result.value.items.map(serializeRecord),
        total: result.value.total,
        page: result.value.page,
        pageSize: result.value.pageSize,
      });
    },
  );

  // ── GET /transactions/:id
  app.get<{ Params: IdParams }>(
    '/transactions/:id',
    {
      preHandler: [requireActiveAccount],
      schema: {
        description: 'Get transaction by id (req 2.1, 2.2, 2.3).',
        tags: ['transactions'],
        params: idParamsSchema,
        response: {
          200: transactionRecordSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          500: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        throw { code: 'TOKEN_MISSING', httpStatus: 401 };
      }

      const { id } = request.params;
      const result = await transactionService.getById(id, ctx.merchantId);
      if (!result.ok) {
        throw result.error;
      }
      void reply.code(200).send(serializeRecord(result.value));
    },
  );
}
