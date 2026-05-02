/**
 * Routes — /v1/reconciliation + /v1/reconciliation/jobs.
 *
 * Implementa requirements 5.1, 5.2, 5.3, 5.4, 5.5 e 6.4.
 *
 * Pré-condições:
 *   - JWT bearer válido.
 *   - Scope `reconciliation:read` (req 5.2).
 *   - merchantId vem dos claims (tenant isolation).
 *
 * Async path:
 *   - GET  /reconciliation        → resposta inline (req 5.1, 5.3, 5.4).
 *   - POST /reconciliation/jobs   → cria job assíncrono (req 5.5).
 *   - GET  /reconciliation/jobs/:jobId → polling (req 5.5).
 */

import type { FastifyInstance } from 'fastify';
import type { AppEnv } from '../../../config/env.js';
import type { ReconciliationQuery } from '../../../shared/types.js';
import { ReconciliationService } from '../../../domain/reconciliation/reconciliation.service.js';
import { ReconciliationQueue } from '../../queue/reconciliation-queue.js';
import { requireActiveAccount, requireScope } from '../middleware/scope.js';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const reconciliationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['startDate', 'endDate'],
  properties: {
    terminalId: { type: 'string', minLength: 1 },
    startDate: { type: 'string', minLength: 1 },
    endDate: { type: 'string', minLength: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
  },
} as const;

const reconciliationJobBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['startDate', 'endDate'],
  properties: {
    terminalId: { type: 'string', minLength: 1 },
    startDate: { type: 'string', minLength: 1 },
    endDate: { type: 'string', minLength: 1 },
  },
} as const;

const reconciliationRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionId',
    'amount',
    'currency',
    'paymentMethodType',
    'authorizationCode',
    'settlementStatus',
    'acquirerReferenceNumber',
  ],
  properties: {
    transactionId: { type: 'string' },
    amount: { type: 'integer' },
    currency: { type: 'string' },
    paymentMethodType: {
      type: 'string',
      enum: ['CREDIT_CARD', 'DEBIT_CARD', 'CONTACTLESS_NFC'],
    },
    authorizationCode: { type: 'string' },
    settlementStatus: {
      type: 'string',
      enum: ['PENDING_SETTLEMENT', 'SETTLED'],
    },
    acquirerReferenceNumber: { type: 'string' },
  },
} as const;

const reconciliationSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['records', 'totalsByMethod', 'generatedAt'],
  properties: {
    records: { type: 'array', items: reconciliationRecordSchema },
    totalsByMethod: {
      type: 'object',
      additionalProperties: { type: 'integer' },
    },
    generatedAt: { type: 'string' },
  },
} as const;

const reconciliationJobSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId', 'status'],
  properties: {
    jobId: { type: 'string' },
    status: {
      type: 'string',
      enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'],
    },
    resultUrl: { type: ['string', 'null'] },
  },
} as const;

const jobIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId'],
  properties: {
    jobId: { type: 'string', format: 'uuid' },
  },
} as const;

const errorEnvelopeSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      properties: { code: { type: 'string' } },
    },
  },
} as const;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface SyncQuery {
  terminalId?: string;
  startDate: string;
  endDate: string;
  pageSize?: number;
}

interface JobBody {
  terminalId?: string;
  startDate: string;
  endDate: string;
}

interface JobIdParams {
  jobId: string;
}

// ─────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────

export interface ReconciliationRouteOptions {
  /** Env carregada — usada para resolver REDIS_URL para o BullMQ. */
  readonly env: AppEnv;
  /** Service injetado em testes. Default: instanciado a partir do env. */
  readonly service?: ReconciliationService;
}

// ─────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────

/**
 * Cria um {@link ReconciliationService} com queue BullMQ wired para o
 * Redis configurado em `env.REDIS_URL`. O {@link ReconciliationQueue}
 * abre conexão lazy quando o método é chamado.
 */
function buildDefaultService(env: AppEnv): ReconciliationService {
  const queue = new ReconciliationQueue({
    connection: { url: env.REDIS_URL },
  });
  return new ReconciliationService({ queue });
}

/**
 * Plugin Fastify que registra as rotas de reconciliação. Deve ser
 * registrado dentro de um `app.register(..., { prefix: '/v1' })`.
 */
export async function reconciliationRoute(
  app: FastifyInstance,
  opts: ReconciliationRouteOptions,
): Promise<void> {
  const service = opts.service ?? buildDefaultService(opts.env);

  // ── GET /reconciliation
  app.get<{ Querystring: SyncQuery }>(
    '/reconciliation',
    {
      preHandler: [requireActiveAccount, requireScope('reconciliation:read')],
      schema: {
        description: 'Inline reconciliation report (req 5.1, 5.2).',
        tags: ['reconciliation'],
        querystring: reconciliationQuerySchema,
        response: {
          200: reconciliationSummarySchema,
          400: errorEnvelopeSchema,
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
      const query: ReconciliationQuery = {
        merchantId: ctx.merchantId,
        ...(q.terminalId !== undefined ? { terminalId: q.terminalId } : {}),
        startDate: q.startDate,
        endDate: q.endDate,
        ...(q.pageSize !== undefined ? { pageSize: q.pageSize } : {}),
      };

      const result = await service.getReconciliation(query);
      if (!result.ok) {
        throw result.error;
      }
      void reply.code(200).send(result.value);
    },
  );

  // ── POST /reconciliation/jobs
  app.post<{ Body: JobBody }>(
    '/reconciliation/jobs',
    {
      preHandler: [requireActiveAccount, requireScope('reconciliation:read')],
      schema: {
        description: 'Create async reconciliation export job (req 5.5).',
        tags: ['reconciliation'],
        body: reconciliationJobBodySchema,
        response: {
          200: reconciliationJobSchema,
          201: reconciliationJobSchema,
          400: errorEnvelopeSchema,
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

      const body = request.body;
      const query: ReconciliationQuery = {
        merchantId: ctx.merchantId,
        ...(body.terminalId !== undefined ? { terminalId: body.terminalId } : {}),
        startDate: body.startDate,
        endDate: body.endDate,
      };

      const result = await service.createExportJob(query);
      if (!result.ok) {
        throw result.error;
      }
      void reply.code(201).send(result.value);
    },
  );

  // ── GET /reconciliation/jobs/:jobId
  app.get<{ Params: JobIdParams }>(
    '/reconciliation/jobs/:jobId',
    {
      preHandler: [requireActiveAccount, requireScope('reconciliation:read')],
      schema: {
        description: 'Poll async reconciliation job status (req 5.5).',
        tags: ['reconciliation'],
        params: jobIdParamsSchema,
        response: {
          200: reconciliationJobSchema,
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

      const result = await service.getJobStatus(request.params.jobId);
      if (!result.ok) {
        throw result.error;
      }
      void reply.code(200).send(result.value);
    },
  );
}
