/**
 * Transaction state machine — validação das transições de status.
 *
 * Source: design.md "Transaction Status Transition Rules" + diagram
 * "Transaction State Machine" + requirements 3.1, 3.2.
 *
 * Tabela de transições permitidas:
 *   (new)    → PENDING, APPROVED, DECLINED
 *   PENDING  → APPROVED, DECLINED
 *   APPROVED → VOIDED, SETTLED
 *   VOIDED   → (terminal)
 *   SETTLED  → (terminal)
 *   DECLINED → (terminal)
 *
 * `from = null` representa o estado inicial "(new)" — uma transação
 * recém-criada que ainda não tem status persistido.
 */

import { TransactionStatus } from '../../shared/enums.js';
import { err, ok, type Result } from '../../shared/result.js';

export type TransitionError = {
  readonly code: 'INVALID_TRANSITION';
  readonly from: TransactionStatus | null;
  readonly to: TransactionStatus;
};

/**
 * Mapa de status atual → set de status permitidos como destino.
 * Os terminais (VOIDED, SETTLED, DECLINED) mapeiam para set vazio.
 */
const ALLOWED: ReadonlyMap<TransactionStatus | 'NEW', ReadonlySet<TransactionStatus>> = new Map([
  [
    'NEW' as const,
    new Set<TransactionStatus>([
      TransactionStatus.PENDING,
      TransactionStatus.APPROVED,
      TransactionStatus.DECLINED,
    ]),
  ],
  [
    TransactionStatus.PENDING,
    new Set<TransactionStatus>([TransactionStatus.APPROVED, TransactionStatus.DECLINED]),
  ],
  [
    TransactionStatus.APPROVED,
    new Set<TransactionStatus>([TransactionStatus.VOIDED, TransactionStatus.SETTLED]),
  ],
  [TransactionStatus.VOIDED, new Set<TransactionStatus>()],
  [TransactionStatus.SETTLED, new Set<TransactionStatus>()],
  [TransactionStatus.DECLINED, new Set<TransactionStatus>()],
]);

/**
 * Verifica se a transição é permitida pelo state machine.
 * `from = null` representa o estado inicial "(new)".
 */
export function transitionAllowed(
  from: TransactionStatus | null,
  to: TransactionStatus,
): boolean {
  const key: TransactionStatus | 'NEW' = from === null ? 'NEW' : from;
  const allowedTargets = ALLOWED.get(key);
  if (!allowedTargets) {
    return false;
  }
  return allowedTargets.has(to);
}

/**
 * Versão "asserting" da validação — retorna `Result<void, TransitionError>`.
 * Usada por serviços de domínio que querem propagar a falha como erro
 * tipado em vez de checar boolean manualmente.
 */
export function assertTransition(
  from: TransactionStatus | null,
  to: TransactionStatus,
): Result<void, TransitionError> {
  if (transitionAllowed(from, to)) {
    return ok(undefined);
  }
  return err({ code: 'INVALID_TRANSITION', from, to });
}
