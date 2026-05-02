/**
 * Utilitários de seed para testes de integração.
 *
 * Tasks 16.x usarão `seedMerchant`, `seedTransaction` e `cleanDatabase`
 * para preparar e isolar cenários por teste.
 *
 * Implementação concreta depende do PrismaClient, que é introduzido em
 * `src/infra/persistence/` pela Task 7.x. Este arquivo provê apenas a
 * superfície contratual + helpers genéricos.
 */

export interface SeedMerchantInput {
  readonly id?: string;
  readonly name?: string;
  readonly accountStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  readonly receiptTemplateId?: string | null;
}

export interface SeededMerchant {
  readonly id: string;
  readonly name: string;
  readonly accountStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  readonly receiptTemplateId: string | null;
}

/**
 * Stub: a Task 7.x preencherá esta função usando o PrismaClient real.
 * Mantido aqui apenas como contrato compartilhado para tests/integration.
 */
export async function seedMerchant(_input: SeedMerchantInput = {}): Promise<SeededMerchant> {
  throw new Error(
    'seedMerchant ainda não implementado: requer PrismaClient da Task 7.x'
  );
}

export async function cleanDatabase(): Promise<void> {
  throw new Error('cleanDatabase ainda não implementado: requer PrismaClient da Task 7.x');
}

/**
 * Helper genérico: gera ID de teste determinístico.
 */
export function testId(prefix: string, n = 1): string {
  return `${prefix}-${n.toString().padStart(4, '0')}`;
}
