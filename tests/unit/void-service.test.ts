/**
 * Unit tests — VoidService (Task 15.2).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4.
 *
 * Cobertura:
 *   1. APPROVED elegivel + acquirer APPROVED -> VOIDED + audit (req 3.1, 3.3).
 *   2. Estado nao elegivel (VOIDED, SETTLED, DECLINED, PENDING) -> 409
 *      com currentStatus correto e SEM atualizacao (req 3.2).
 *   3. Acquirer rejeita void (DECLINED) -> 422 ACQUIRER_REJECTED, status
 *      original mantido (req 3.4).
 *   4. Transaction nao encontrada -> 404 NOT_FOUND.
 */

import './../setup/env.js';

import { describe, expect, it, vi } from 'vitest';

import { VoidService } from '../../src/domain/void/void.service.js';
import { ok } from '../../src/shared/result.js';
import {
  PaymentMethodType,
  TransactionStatus,
} from '../../src/shared/enums.js';
import type {
  AcquirerResult,
  TransactionRecord,
  VoidCommand,
} from '../../src/shared/types.js';

const MERCHANT_ID = 'mch_1';
const TRANSACTION_ID = 'tx_1';
const OPERATOR_ID = 'op-123';

function buildVoidCommand(overrides: Partial<VoidCommand> = {}): VoidCommand {
  return {
    transactionId: TRANSACTION_ID,
    merchantId: MERCHANT_ID,
    operatorId: OPERATOR_ID,
    ...overrides,
  };
}

function buildTransactionRecord(
  overrides: Partial<TransactionRecord> = {},
): TransactionRecord {
  const now = new Date('2026-05-02T10:00:00.000Z').toISOString();
  return {
    id: TRANSACTION_ID,
    merchantId: MERCHANT_ID,
    terminalId: 'trm_1',
    amount: 1000,
    currency: 'BRL',
    paymentMethodType: PaymentMethodType.CREDIT_CARD,
    maskedPan: '****1234',
    status: TransactionStatus.APPROVED,
    authorizationCode: 'AUTH1',
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

function buildAcquirerResult(
  overrides: Partial<AcquirerResult> = {},
): AcquirerResult {
  return {
    outcome: 'APPROVED',
    authorizationCode: 'AUTH1',
    acquirerReferenceNumber: 'REF1',
    declineCode: null,
    rawResponseCode: '00',
    ...overrides,
  };
}

interface MockRepo {
  findById: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listForReconciliation: ReturnType<typeof vi.fn>;
}

function buildRepoMock(): MockRepo {
  return {
    findById: vi.fn(),
    updateStatus: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    listForReconciliation: vi.fn(),
  };
}

interface MockAcquirer {
  authorize: ReturnType<typeof vi.fn>;
  void: ReturnType<typeof vi.fn>;
}

function buildAcquirerMock(): MockAcquirer {
  return {
    authorize: vi.fn(),
    void: vi.fn(),
  };
}

interface MockAudit {
  write: ReturnType<typeof vi.fn>;
}

function buildAuditMock(): MockAudit {
  return { write: vi.fn().mockResolvedValue(undefined) };
}

// ─────────────────────────────────────────────────────────────────
// Suites
// ─────────────────────────────────────────────────────────────────

describe('VoidService.void — APPROVED elegivel -> VOIDED (Reqs 3.1, 3.3)', () => {
  it('atualiza status para VOIDED, dispara audit VOID e retorna VoidResult', async () => {
    const tx = buildTransactionRecord({
      status: TransactionStatus.APPROVED,
      authorizationCode: 'AUTH1',
      version: 0,
    });
    const repo = buildRepoMock();
    repo.findById.mockResolvedValue(tx);
    const updatedRecord: TransactionRecord = buildTransactionRecord({
      status: TransactionStatus.VOIDED,
      voidedBy: OPERATOR_ID,
      voidedAt: new Date().toISOString(),
      version: 1,
    });
    repo.updateStatus.mockResolvedValue(ok(updatedRecord));

    const acquirer = buildAcquirerMock();
    acquirer.void.mockResolvedValue(ok(buildAcquirerResult()));

    const audit = buildAuditMock();

    const service = new VoidService({
      transactionRepository: repo as never,
      acquirerAdapter: acquirer as never,
      auditLogRepository: audit as never,
    });

    const result = await service.void(buildVoidCommand());

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.value.status).toBe('VOIDED');
      expect(result.value.transactionId).toBe(TRANSACTION_ID);
      expect(result.value.voidedBy).toBe(OPERATOR_ID);
      expect(typeof result.value.voidedAt).toBe('string');
    }

    expect(repo.updateStatus).toHaveBeenCalledTimes(1);
    const args = repo.updateStatus.mock.calls[0] as [
      string,
      number,
      string,
      { voidedBy?: string; voidedAt?: Date },
    ];
    expect(args[0]).toBe(TRANSACTION_ID);
    expect(args[1]).toBe(0); // expectedVersion
    expect(args[2]).toBe(TransactionStatus.VOIDED);
    expect(args[3]?.voidedBy).toBe(OPERATOR_ID);
    expect(args[3]?.voidedAt).toBeInstanceOf(Date);

    expect(audit.write).toHaveBeenCalledTimes(1);
    const auditArg = audit.write.mock.calls[0]?.[0] as
      | { action: string; outcome: string; resourceId: string }
      | undefined;
    expect(auditArg?.action).toBe('VOID');
    expect(auditArg?.outcome).toBe('SUCCESS');
    expect(auditArg?.resourceId).toBe(TRANSACTION_ID);
  });
});

describe('VoidService.void — estado nao elegivel -> 409 (Req 3.2)', () => {
  for (const status of [
    TransactionStatus.VOIDED,
    TransactionStatus.SETTLED,
    TransactionStatus.DECLINED,
    TransactionStatus.PENDING,
  ] as const) {
    it(`retorna NOT_ELIGIBLE com currentStatus=${status} sem chamar updateStatus`, async () => {
      const tx = buildTransactionRecord({ status });
      const repo = buildRepoMock();
      repo.findById.mockResolvedValue(tx);
      const acquirer = buildAcquirerMock();
      const audit = buildAuditMock();

      const service = new VoidService({
        transactionRepository: repo as never,
        acquirerAdapter: acquirer as never,
        auditLogRepository: audit as never,
      });

      const result = await service.void(buildVoidCommand());

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error.code).toBe('NOT_ELIGIBLE');
        expect(result.error.httpStatus).toBe(409);
        if (result.error.code === 'NOT_ELIGIBLE') {
          expect(result.error.currentStatus).toBe(status);
        }
      }

      expect(repo.updateStatus).not.toHaveBeenCalled();
      // Acquirer tampouco deve ser chamado para um estado nao elegivel.
      expect(acquirer.void).not.toHaveBeenCalled();
    });
  }
});

describe('VoidService.void — acquirer rejeita void -> 422 (Req 3.4)', () => {
  it('retorna ACQUIRER_REJECTED quando acquirer.void devolve outcome DECLINED, mantendo status original', async () => {
    const tx = buildTransactionRecord({
      status: TransactionStatus.APPROVED,
      authorizationCode: 'AUTH1',
      version: 0,
    });
    const repo = buildRepoMock();
    repo.findById.mockResolvedValue(tx);

    const acquirer = buildAcquirerMock();
    acquirer.void.mockResolvedValue(
      ok(
        buildAcquirerResult({
          outcome: 'DECLINED',
          authorizationCode: null,
          declineCode: 'NOT_FOUND_AT_ACQUIRER',
        }),
      ),
    );

    const audit = buildAuditMock();

    const service = new VoidService({
      transactionRepository: repo as never,
      acquirerAdapter: acquirer as never,
      auditLogRepository: audit as never,
    });

    const result = await service.void(buildVoidCommand());

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('ACQUIRER_REJECTED');
      expect(result.error.httpStatus).toBe(422);
      if (result.error.code === 'ACQUIRER_REJECTED') {
        expect(result.error.reason).toBe('NOT_FOUND_AT_ACQUIRER');
      }
    }

    // Status original mantido — updateStatus NUNCA foi chamado.
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });
});

describe('VoidService.void — transaction nao encontrada -> 404', () => {
  it('retorna NOT_FOUND quando o repo devolve null', async () => {
    const repo = buildRepoMock();
    repo.findById.mockResolvedValue(null);
    const acquirer = buildAcquirerMock();
    const audit = buildAuditMock();

    const service = new VoidService({
      transactionRepository: repo as never,
      acquirerAdapter: acquirer as never,
      auditLogRepository: audit as never,
    });

    const result = await service.void(buildVoidCommand());

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.httpStatus).toBe(404);
    }

    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(acquirer.void).not.toHaveBeenCalled();
  });
});
