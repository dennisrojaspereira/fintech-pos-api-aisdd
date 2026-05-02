/**
 * JWT Authentication middleware (Fastify onRequest hook).
 *
 * Implementa requirements 6.1 e 6.2:
 *   - 6.1: Token JWT bearer obrigatório em todas as rotas protegidas.
 *   - 6.2: HTTP 401 para token ausente, expirado ou invalido.
 *
 * Detalhes de design (ver design.md "Auth Middleware" e "Security Considerations"):
 *   - RS256 obrigatorio. HS256 (e qualquer outro algoritmo simétrico ou `none`)
 *     é rejeitado explicitamente lendo o header do JWT antes do verify.
 *   - Claims `exp` e `iss` validados. O issuer é comparado com `JWT_ISSUER`.
 *   - Claims extraidos: merchantId, terminalId (pode ser null), operatorId
 *     (pode ser null), scopes (string[]), accountStatus.
 *   - O contexto verificado é injetado em `request.authContext` para que os
 *     pre-handlers e services downstream consumam.
 *   - Hook é registrado como `onRequest` e faz bypass condicional para
 *     `GET /health` (requirement 8.5: health probe sem auth).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import type { AppEnv } from '../../../config/env.js';
import { AccountStatus } from '../../../shared/enums.js';
import type { AuthContext, AuthError } from '../../../shared/types.js';
import { err, ok, type Result } from '../../../shared/result.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populado pelo hook onRequest após verificação bem-sucedida do JWT. */
    authContext?: AuthContext;
  }
}

export interface RegisterAuthOptions {
  readonly env: AppEnv;
}

/**
 * Verifica um token JWT RS256 e retorna o AuthContext extraido dos claims.
 *
 * Exposto para reuso em testes unitarios.
 */
export function verifyJwt(
  token: string,
  env: AppEnv
): Result<AuthContext, AuthError> {
  if (!token || token.trim().length === 0) {
    return err({ code: 'TOKEN_MISSING', httpStatus: 401 });
  }

  // ── 1. Inspeciona o header do JWT ANTES do verify para rejeitar HS256/none.
  const decodedHeader = jwt.decode(token, { complete: true });
  if (
    decodedHeader === null ||
    typeof decodedHeader !== 'object' ||
    decodedHeader.header.alg !== 'RS256'
  ) {
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }

  // ── 2. Verifica assinatura, exp e iss.
  let payload: JwtPayload | string;
  try {
    payload = jwt.verify(token, env.JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer: env.JWT_ISSUER,
    });
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) {
      return err({ code: 'TOKEN_EXPIRED', httpStatus: 401 });
    }
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }

  if (typeof payload === 'string') {
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }

  // ── 3. Extrai claims com validação defensiva.
  const merchantId = payload['merchantId'];
  const terminalIdRaw = payload['terminalId'];
  const operatorIdRaw = payload['operatorId'];
  const scopesRaw = payload['scopes'];
  const accountStatusRaw = payload['accountStatus'];

  if (typeof merchantId !== 'string' || merchantId.length === 0) {
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }

  const terminalId =
    typeof terminalIdRaw === 'string' && terminalIdRaw.length > 0 ? terminalIdRaw : null;
  const operatorId =
    typeof operatorIdRaw === 'string' && operatorIdRaw.length > 0 ? operatorIdRaw : null;

  if (
    !Array.isArray(scopesRaw) ||
    !scopesRaw.every((s): s is string => typeof s === 'string')
  ) {
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }
  const scopes: readonly string[] = Object.freeze([...scopesRaw]);

  if (
    typeof accountStatusRaw !== 'string' ||
    !(accountStatusRaw in AccountStatus)
  ) {
    return err({ code: 'TOKEN_INVALID', httpStatus: 401 });
  }
  const accountStatus = accountStatusRaw as AuthContext['accountStatus'];

  const ctx: AuthContext = {
    merchantId,
    terminalId,
    operatorId,
    scopes,
    accountStatus,
  };
  return ok(ctx);
}

/**
 * Extrai o token bearer do header Authorization. Retorna `null` se ausente
 * ou em formato invalido.
 */
function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * `GET /health` é exposto sem autenticação (requirement 8.5). Qualquer outra
 * rota passa pelo verify do JWT.
 */
function isPublicRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false;
  // request.url pode incluir querystring; comparar pelo path puro.
  const pathOnly = request.url.split('?')[0] ?? request.url;
  return pathOnly === '/health';
}

/**
 * Resposta 401 estruturada. Não vaza detalhes do motivo além do code.
 */
function send401(reply: FastifyReply, code: AuthError['code']): void {
  void reply.code(401).send({
    error: {
      code,
      message: 'Unauthorized',
    },
  });
}

/**
 * Registra o hook `onRequest` que valida o JWT em todas as rotas exceto
 * `GET /health`. O AuthContext resultante é anexado em `request.authContext`.
 */
export function registerAuth(app: FastifyInstance, opts: RegisterAuthOptions): void {
  const { env } = opts;

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request)) {
      return;
    }

    const token = extractBearerToken(request);
    if (token === null) {
      send401(reply, 'TOKEN_MISSING');
      return reply;
    }

    const result = verifyJwt(token, env);
    if (!result.ok) {
      send401(reply, result.error.code);
      return reply;
    }

    request.authContext = result.value;
    return;
  });
}
