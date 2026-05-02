/**
 * Routes — GET /v1/transactions/:id/receipt.
 *
 * Implementa requirements 4.1, 4.2, 4.3, 4.5 e 6.4.
 */

import type { FastifyInstance } from 'fastify';
import { receiptService } from '../../../domain/receipt/receipt.service.js';
import { requireActiveAccount } from '../middleware/scope.js';

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const receiptSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionId',
    'merchantName',
    'terminalId',
    'amount',
    'currency',
    'paymentMethodType',
    'maskedPan',
    'transactionTimestamp',
  ],
  properties: {
    transactionId: { type: 'string' },
    merchantName: { type: 'string' },
    terminalId: { type: 'string' },
    amount: { type: 'integer' },
    currency: { type: 'string' },
    paymentMethodType: {
      type: 'string',
      enum: ['CREDIT_CARD', 'DEBIT_CARD', 'CONTACTLESS_NFC'],
    },
    maskedPan: { type: 'string' },
    authorizationCode: { type: ['string', 'null'] },
    transactionTimestamp: { type: 'string' },
    receiptTemplate: { type: ['string', 'null'] },
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

export async function receiptRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: IdParams }>(
    '/transactions/:id/receipt',
    {
      preHandler: [requireActiveAccount],
      schema: {
        description: 'Get receipt for an APPROVED/VOIDED transaction (req 4.1).',
        tags: ['transactions'],
        params: idParamsSchema,
        response: {
          200: receiptSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          500: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        throw { code: 'TOKEN_MISSING', httpStatus: 401 };
      }

      const result = await receiptService.getReceipt(
        request.params.id,
        ctx.merchantId,
      );
      if (!result.ok) {
        throw result.error;
      }

      void reply.code(200).send({
        transactionId: result.value.transactionId,
        merchantName: result.value.merchantName,
        terminalId: result.value.terminalId,
        amount: result.value.amount,
        currency: result.value.currency,
        paymentMethodType: result.value.paymentMethodType,
        maskedPan: result.value.maskedPan,
        authorizationCode: result.value.authorizationCode,
        transactionTimestamp: result.value.transactionTimestamp,
        receiptTemplate: result.value.receiptTemplate,
      });
    },
  );
}
