/**
 * GET /health
 *
 * Liveness/readiness probe (requirement 8.5).
 * NÃO é protegido por auth — registrado fora do hook onRequest de JWT.
 */

import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        description: 'Liveness/readiness probe — sem autenticação.',
        tags: ['health'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['ok'] },
              uptime: { type: 'number' },
            },
            required: ['status', 'uptime'],
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptime: process.uptime(),
    })
  );
}
