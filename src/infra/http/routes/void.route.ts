/**
 * Routes — POST /v1/transactions/:id/void.
 *
 * Implementa requirements 3.1, 3.2, 3.3, 3.4, 3.5 e 6.4.
 *
 * Pré-condições:
 *   - JWT bearer válido (registerAuth global).
 *   - Scope `transactions:void` (req 3.5) — aplicado via `requireScope`.
 *   - merchantId vem dos claims; tenant isolation no service.
 */

import type { FastifyInstance } from 'fastify';
import type { VoidCommand } from '../../../shared/types.js';
import { voidService } from '../../../domain/void/void.service.js';
import { requireActiveAccount, requireScope } from '../middleware/scope.js';

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const voidResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId', 'status', 'voidedAt', 'voidedBy'],
  properties: {
    transactionId: { type: 'string' },
    status: { type: 'string', enum: ['VOIDED'] },
    voidedAt: { type: 'string' },
    voidedBy: { type: 'string' },
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

interface IdParams {
  id: string;
}

export async function voidRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: IdParams }>(
    '/transactions/:id/void',
    {
      preHandler: [requireActiveAccount, requireScope('transactions:void')],
      schema: {
        description: 'Void an APPROVED transaction (req 3.1, 3.5).',
        tags: ['transactions'],
        params: idParamsSchema,
        response: {
          200: voidResultSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
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
        throw { code: 'TOKEN_MISSING', httpStatus: 401 };
      }

      // operatorId é obrigatório para void: registramos quem cancelou (req 3.3).
      // Em ausência (token de máquina sem operatorId), tratamos como 403.
      if (ctx.operatorId === null) {
        throw {
          code: 'SCOPE_MISSING',
          httpStatus: 403,
          reason: 'operator identity required for void',
        };
      }

      const cmd: VoidCommand = {
        transactionId: request.params.id,
        merchantId: ctx.merchantId,
        operatorId: ctx.operatorId,
      };

      const result = await voidService.void(cmd);
      if (!result.ok) {
        throw result.error;
      }

      void reply.code(200).send({
        transactionId: result.value.transactionId,
        status: result.value.status,
        voidedAt: result.value.voidedAt,
        voidedBy: result.value.voidedBy,
      });
    },
  );
}
