/**
 * PrismaClient singleton.
 *
 * Source: design.md "Tech Stack: Prisma 5.x" + Performance section
 * ("Connection Pooling configured per environment"). Mantemos uma única
 * instância por processo Node.js para reaproveitar o pool.
 *
 * Em fase de desenvolvimento com hot-reload (`tsx watch`) também
 * preservamos a instância em `globalThis` para evitar vazamentos de
 * conexão a cada reload (padrão recomendado pela documentação Prisma).
 */

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __posApiPrismaClient: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__posApiPrismaClient ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__posApiPrismaClient = prisma;
}
