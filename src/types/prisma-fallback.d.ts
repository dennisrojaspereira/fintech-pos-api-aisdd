/**
 * Fallback de tipos para o cliente Prisma quando `prisma generate` ainda
 * não foi executado.
 *
 * O pacote `@prisma/client` reexporta de `.prisma/client/default`, que é
 * gerado pelo comando `prisma generate`. Em ambientes onde o engine não
 * pode ser baixado (sandboxes restritos, primeiro clone antes de
 * `npm run prisma:generate`), o módulo `.prisma/client/default` não existe
 * e `tsc` falha com TS2305.
 *
 * Este arquivo declara um ambient module com a superfície mínima usada
 * pelos repositórios. Quando `prisma generate` roda, ele escreve
 * `node_modules/.prisma/client/default.d.ts` com tipos REAIS que vencem
 * por proximidade na resolução, tornando este fallback inerte.
 *
 * NÃO use estes tipos em código novo — sempre prefira a tipagem real
 * gerada pelo Prisma. Após `prisma:generate`, este arquivo desliga.
 */

declare module '.prisma/client/default' {
  // PrismaClient com superfície mínima para os repos compilarem sem `generate`.
  // Em runtime, sempre o valor gerado pelo Prisma é usado.
  export class PrismaClient<
    _T = unknown,
    _U = unknown,
    _V = unknown
  > {
    constructor(options?: unknown);
    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
    // Aceita qualquer transação interativa: a tipagem real vem com o generate.
    $transaction: any;
    $on(event: string, cb: (...args: unknown[]) => void): void;

    // Modelos do schema.prisma. Tipados como `any` para permitir o build
    // sem o codegen (substituídos pelos tipos reais ao gerar).
    merchant: any;
    terminal: any;
    transaction: any;
    auditEntry: any;
    reconciliationJob: any;
  }

  export namespace Prisma {
    type TransactionClient = any;
    type JsonValue = unknown;
    type InputJsonValue = unknown;
  }
}
