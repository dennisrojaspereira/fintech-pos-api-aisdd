/**
 * Scope enforcement + merchant account status pre-handlers.
 *
 * Implementa requirements 6.3, 6.4 e 6.5:
 *   - 6.3: HTTP 403 quando o token nao inclui o escopo necessario.
 *   - 6.4: Tenant isolation. ATENÇÃO — REGRA CRITICA: `merchantId` SEMPRE vem
 *     dos claims do JWT (request.authContext), NUNCA do request body. Esses
 *     pre-handlers garantem o `authContext` populado, e os repos downstream
 *     devem ler `authContext.merchantId` para todos os WHERE clauses.
 *   - 6.5: HTTP 403 com `reason` quando `accountStatus !== 'ACTIVE'`
 *     (INACTIVE → ACCOUNT_INACTIVE; SUSPENDED → ACCOUNT_SUSPENDED).
 *
 * Todos os pre-handlers assumem que `request.authContext` ja foi populado pelo
 * hook `onRequest` registrado por `registerAuth` (auth.ts). Caso contrario
 * retornam 401 — defense in depth.
 */

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { AccountStatus } from '../../../shared/enums.js';
import type { AuthError } from '../../../shared/types.js';

function send401(reply: FastifyReply): void {
  void reply.code(401).send({
    error: { code: 'TOKEN_MISSING', message: 'Unauthorized' },
  });
}

function send403(
  reply: FastifyReply,
  code: Extract<AuthError, { httpStatus: 403 }>['code'],
  reason?: string
): void {
  void reply.code(403).send({
    error: {
      code,
      message: 'Forbidden',
      ...(reason !== undefined ? { reason } : {}),
    },
  });
}

/**
 * Factory que produz um pre-handler exigindo um escopo especifico.
 *
 * Uso:
 *   app.post('/transactions/:id/void', { preHandler: requireScope('transactions:void') }, handler)
 *
 * Retornos:
 *   - 401 se `authContext` ausente (o onRequest deveria ter bloqueado antes).
 *   - 403 SCOPE_MISSING se `authContext.scopes` nao contem o escopo solicitado.
 */
export function requireScope(scope: string): preHandlerAsyncHookHandler {
  return async function scopeGuard(request: FastifyRequest, reply: FastifyReply) {
    const ctx = request.authContext;
    if (ctx === undefined) {
      send401(reply);
      return reply;
    }
    if (!ctx.scopes.includes(scope)) {
      send403(reply, 'SCOPE_MISSING', `missing scope: ${scope}`);
      return reply;
    }
    return;
  };
}

/**
 * Pre-handler que rejeita requests cujo merchant nao esta ACTIVE.
 *
 * Mapeamento:
 *   - SUSPENDED → 403 ACCOUNT_SUSPENDED
 *   - INACTIVE  → 403 ACCOUNT_INACTIVE
 *   - ACTIVE    → passa adiante.
 */
export const requireActiveAccount: preHandlerAsyncHookHandler = async function (
  request: FastifyRequest,
  reply: FastifyReply
) {
  const ctx = request.authContext;
  if (ctx === undefined) {
    send401(reply);
    return reply;
  }

  if (ctx.accountStatus === AccountStatus.SUSPENDED) {
    send403(reply, 'ACCOUNT_SUSPENDED', 'merchant account is suspended');
    return reply;
  }

  if (ctx.accountStatus === AccountStatus.INACTIVE) {
    send403(reply, 'ACCOUNT_INACTIVE', 'merchant account is inactive');
    return reply;
  }

  return;
};
