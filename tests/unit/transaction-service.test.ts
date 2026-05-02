/**
 * Unit tests — TransactionService (Task 15.1).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.5.
 *
 * Cobertura:
 *   1. Outcome APPROVED do acquirer  -> status APPROVED + audit SUCCESS
 *      (reqs 1.1, 1.4, 1.5).
 *   2. Outcome DECLINED              -> status DECLINED + audit FAILURE
 *      (reqs 1.4, 1.5).
 *   3. Outcome TIMEOUT               -> status PENDING (req 1.6).
 *   4. amount invalido               -> VALIDATION_ERROR 422 com field
 *      'amount' (reqs 1.2, 1.3).
 *   5. MaskedPan rejeita PAN completo (req 4.5 / Security Considerations).
 *
 * Estrategia:
 *   - vi.fn() para repo / audit / acquirer.
 *   - db.$transaction com mock que invoca o callback, passando um stub
 *     do PrismaClient cujo `.terminal.findUnique` devolve um terminal
 *     pertencente ao merchantId. O TransactionRepository instanciado
 *     dentro da transaction usa esse mesmo client para o `.create()`
 *     da transacao — assim verificamos as chamadas via `db.transaction.create`.
 */

import './../setup/env.js';

import { describe, expect, it, vi } from 'vitest';

import { TransactionService } from '../../src/domain/transaction/transaction.service.js';
import { MaskedPan } from '../../src/domain/value-objects/masked-pan.js';
import { ok } from '../../src/shared/result.js';
import {
  PaymentMethodType,
  TransactionStatus,
} from '../../src/shared/enums.js';
import type {
  AcquirerResult,
  AuthorizeCommand,
  TransactionRecord,
} from '../../src/shared/types.js';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const MERCHANT_ID = 'mch_1';
const TERMINAL_ID = 'trm_1';

function buildAuthorizeCommand(
  overrides: Partial<AuthorizeCommand> = {},
): AuthorizeCommand {
  return {
    merchantId: MERCHANT_ID,
    terminalId: TERMINAL_ID,
    amount: 1000,
    currency: 'BRL',
    paymentMethod: {
      type: PaymentMethodType.CREDIT_CARD,
      maskedPan: '****1234',
      expiryMonth: 12,
      expiryYear: 2030,
    },
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

function buildAcquirerResult(
  overrides: Partial<AcquirerResult> = {},
): AcquirerResult {
  return {
    outcome: 'APPROVED',
    authorizationCode: 'AUTH123',
    acquirerReferenceNumber: 'REF1',
    declineCode: null,
    rawResponseCode: '00',
    ...overrides,
  };
}

function buildTransactionRecord(
  overrides: Partial<TransactionRecord> = {},
): TransactionRecord {
  const now = new Date('2026-05-02T10:00:00.000Z').toISOString();
  return {
    id: 'tx_1',
    merchantId: MERCHANT_ID,
    terminalId: TERMINAL_ID,
    amount: 1000,
    currency: 'BRL',
    paymentMethodType: PaymentMethodType.CREDIT_CARD,
    maskedPan: '****1234',
    status: TransactionStatus.APPROVED,
    authorizationCode: 'AUTH123',
    acquirerReferenceNumber: 'REF1',
    acquirerDeclineCode: null,
    voidedBy: null,
    voidedAt: null,
    lastAcquirerCheckAt: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...overrides,
  };
}

/**
 * Constroi um stub minimo de PrismaClient que cobre:
 *   - `terminal.findUnique` para o ownership check.
 *   - `transaction.create` para o create dentro do TransactionRepository.
 *
 * Recebe o registro pronto que o `transaction.create` do prisma deve
 * "inserir" — o repo mapeia row -> TransactionRecord.
 */
function buildDbStub(prismaRow: {
  id: string;
  merchantId: string;
  terminalId: string;
  amount: number;
  currency: string;
  paymentMethodType: string;
  maskedPan: string;
  status: string;
  authorizationCode: string | null;
  acquirerReferenceNumber: string | null;
  acquirerDeclineCode: string | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  lastAcquirerCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}): {
  db: {
    terminal: { findUnique: ReturnType<typeof vi.fn> };
    transaction: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  spies: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
} {
  const findUnique = vi.fn().mockResolvedValue({
    id: prismaRow.terminalId,
    merchantId: prismaRow.merchantId,
  });
  const create = vi.fn().mockResolvedValue(prismaRow);

  const db = {
    terminal: { findUnique },
    transaction: { create },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      // O service chama new TransactionRepository(tx) e depois tx.create.
      // Passamos o mesmo `db` como tx — assim cobre o caminho da
      // transactional client e mantem as spies acessiveis.
      return cb(db);
    }),
  };
  return { db, spies: { create, findUnique } };
}

function rowFor(record: TransactionRecord): {
  id: string;
  merchantId: string;
  terminalId: string;
  amount: number;
  currency: string;
  paymentMethodType: string;
  maskedPan: string;
  status: string;
  authorizationCode: string | null;
  acquirerReferenceNumber: string | null;
  acquirerDeclineCode: string | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  lastAcquirerCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
} {
  return {
    id: record.id,
    merchantId: record.merchantId,
    terminalId: record.terminalId,
    amount: record.amount,
    currency: record.currency,
    paymentMethodType: record.paymentMethodType,
    maskedPan: record.maskedPan,
    status: record.status,
    authorizationCode: record.authorizationCode,
    acquirerReferenceNumber: record.acquirerReferenceNumber,
    acquirerDeclineCode: record.acquirerDeclineCode,
    voidedBy: record.voidedBy,
    voidedAt: record.voidedAt ? new Date(record.voidedAt) : null,
    lastAcquirerCheckAt: record.lastAcquirerCheckAt
      ? new Date(record.lastAcquirerCheckAt)
      : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    version: record.version,
  };
}

// ─────────────────────────────────────────────────────────────────
// Suites
// ─────────────────────────────────────────────────────────────────

describe('TransactionService.authorize — APPROVED outcome (Reqs 1.1, 1.4, 1.5)', () => {
  it('persiste status APPROVED, retorna ok com authorizationCode e dispara audit SUCCESS', async () => {
    const cmd = buildAuthorizeCommand();
    const acquirer = {
      authorize: vi.fn().mockResolvedValue(ok(buildAcquirerResult())),
      void: vi.fn(),
    };
    const audit = { write: vi.fn().mockResolvedValue(undefined) };
    const repo = {
      findById: vi.fn(),
      updateStatus: vi.fn(),
      list: vi.fn(),
      listForReconciliation: vi.fn(),
    };

    const record = buildTransactionRecord({
      status: TransactionStatus.APPROVED,
      authorizationCode: 'AUTH123',
      acquirerReferenceNumber: 'REF1',
    });
    const { db, spies } = buildDbStub(rowFor(record));

    const service = new TransactionService({
      // The repo passed via DI is used by getById/list paths; for
      // authorize the repository is instantiated against the tx client
      // returned by $transaction. We still inject `repo` to satisfy DI.
      repo: repo as never,
      audit: audit as never,
      acquirer: acquirer as never,
      db: db as never,
    });

    const result = await service.authorize(cmd);

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.value.status).toBe(TransactionStatus.APPROVED);
      expect(result.value.authorizationCode).toBe('AUTH123');
      expect(result.value.transactionId).toBe(record.id);
    }

    // repo.create chamado com status APPROVED via prisma.transaction.create.
    expect(spies.create).toHaveBeenCalledTimes(1);
    const createArg = spies.create.mock.calls[0]?.[0] as
      | { data: { status: string } }
      | undefined;
    expect(createArg?.data.status).toBe(TransactionStatus.APPROVED);

    // audit.write chamado com action AUTHORIZE / outcome SUCCESS.
    expect(audit.write).toHaveBeenCalledTimes(1);
    const auditArg = audit.write.mock.calls[0]?.[0] as
      | { action: string; outcome: string }
      | undefined;
    expect(auditArg?.action).toBe('AUTHORIZE');
    expect(auditArg?.outcome).toBe('SUCCESS');
  });
});

describe('TransactionService.authorize — DECLINED outcome (Reqs 1.4, 1.5)', () => {
  it('persiste status DECLINED com declineCode e retorna ok', async () => {
    const cmd = buildAuthorizeCommand();
    const acquirer = {
      authorize: vi.fn().mockResolvedValue(
        ok(
          buildAcquirerResult({
            outcome: 'DECLINED',
            authorizationCode: null,
            declineCode: 'INSUFFICIENT_FUNDS',
            rawResponseCode: '51',
          }),
        ),
      ),
      void: vi.fn(),
    };
    const audit = { write: vi.fn().mockResolvedValue(undefined) };
    const repo = {
      findById: vi.fn(),
      updateStatus: vi.fn(),
      list: vi.fn(),
      listForReconciliation: vi.fn(),
    };

    const record = buildTransactionRecord({
      status: TransactionStatus.DECLINED,
      authorizationCode: null,
      acquirerDeclineCode: 'INSUFFICIENT_FUNDS',
    });
    const { db, spies } = buildDbStub(rowFor(record));

    const service = new TransactionService({
      repo: repo as never,
      audit: audit as never,
      acquirer: acquirer as never,
      db: db as never,
    });

    const result = await service.authorize(cmd);

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.value.status).toBe(TransactionStatus.DECLINED);
      expect(result.value.acquirerDeclineCode).toBe('INSUFFICIENT_FUNDS');
    }

    expect(spies.create).toHaveBeenCalledTimes(1);
    const createArg = spies.create.mock.calls[0]?.[0] as
      | { data: { status: string; acquirerDeclineCode: string | null } }
      | undefined;
    expect(createArg?.data.status).toBe(TransactionStatus.DECLINED);
    expect(createArg?.data.acquirerDeclineCode).toBe('INSUFFICIENT_FUNDS');

    // audit FAILURE em DECLINED (status nao APPROVED).
    expect(audit.write).toHaveBeenCalledTimes(1);
    const auditArg = audit.write.mock.calls[0]?.[0] as
      | { action: string; outcome: string }
      | undefined;
    expect(auditArg?.action).toBe('AUTHORIZE');
    expect(auditArg?.outcome).toBe('FAILURE');
  });
});

describe('TransactionService.authorize — TIMEOUT outcome -> PENDING (Req 1.6)', () => {
  it('mapeia TIMEOUT do acquirer para status PENDING', async () => {
    const cmd = buildAuthorizeCommand();
    const acquirer = {
      authorize: vi.fn().mockResolvedValue(
        ok(
          buildAcquirerResult({
            outcome: 'TIMEOUT',
            authorizationCode: null,
            acquirerReferenceNumber: null,
            declineCode: null,
            rawResponseCode: null,
          }),
        ),
      ),
      void: vi.fn(),
    };
    const audit = { write: vi.fn().mockResolvedValue(undefined) };
    const repo = {
      findById: vi.fn(),
      updateStatus: vi.fn(),
      list: vi.fn(),
      listForReconciliation: vi.fn(),
    };

    const record = buildTransactionRecord({
      status: TransactionStatus.PENDING,
      authorizationCode: null,
      acquirerReferenceNumber: null,
    });
    const { db, spies } = buildDbStub(rowFor(record));

    const service = new TransactionService({
      repo: repo as never,
      audit: audit as never,
      acquirer: acquirer as never,
      db: db as never,
    });

    const result = await service.authorize(cmd);

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.value.status).toBe(TransactionStatus.PENDING);
    }

    expect(spies.create).toHaveBeenCalledTimes(1);
    const createArg = spies.create.mock.calls[0]?.[0] as
      | { data: { status: string } }
      | undefined;
    expect(createArg?.data.status).toBe(TransactionStatus.PENDING);
  });
});

describe('TransactionService.authorize — VALIDATION_ERROR (Reqs 1.2, 1.3)', () => {
  it('retorna 422 com field amount quando amount eh invalido (-10)', async () => {
    const cmd = buildAuthorizeCommand({ amount: -10 });
    const acquirer = {
      authorize: vi.fn(),
      void: vi.fn(),
    };
    const audit = { write: vi.fn() };
    const repo = {
      findById: vi.fn(),
      updateStatus: vi.fn(),
      list: vi.fn(),
      listForReconciliation: vi.fn(),
    };
    const { db } = buildDbStub(rowFor(buildTransactionRecord()));

    const service = new TransactionService({
      repo: repo as never,
      audit: audit as never,
      acquirer: acquirer as never,
      db: db as never,
    });

    const result = await service.authorize(cmd);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.httpStatus).toBe(422);
      if (result.error.code === 'VALIDATION_ERROR') {
        const fields = result.error.fields.map((f) => f.field);
        expect(fields).toContain('amount');
      }
    }

    // Acquirer NUNCA deve ser invocado quando a validacao falha.
    expect(acquirer.authorize).not.toHaveBeenCalled();
  });
});

describe('MaskedPan.create — full PAN forbidden (Req 4.5)', () => {
  it('rejeita um PAN completo de 16 digitos com FULL_PAN_FORBIDDEN', () => {
    const result = MaskedPan.create('4111111111111111');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('FULL_PAN_FORBIDDEN');
    }
  });

  it('aceita formato mascarado valido ****1234', () => {
    const result = MaskedPan.create('****1234');
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.value.value).toBe('****1234');
      expect(result.value.last4()).toBe('1234');
    }
  });
});
