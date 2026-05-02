/**
 * Receipt Service — compoe o payload de recibo para transacoes
 * APPROVED ou VOIDED.
 *
 * Source:
 *   - design.md "Receipt Service" (secao Components and Interfaces)
 *   - requirements.md 4.1, 4.2, 4.3, 4.4, 4.5
 *   - tasks.md task 11.1
 *
 * Notas:
 *   - Este servico retorna um {@link ReceiptPayload} ja estruturado em
 *     JSON (req 4.3). A *renderizacao* do template (HTML/PDF/print) e
 *     responsabilidade do consumidor (terminal, backoffice). Aqui so
 *     identificamos qual template aplicar via `receiptTemplate`
 *     (req 4.4).
 *   - PAN nunca e re-mascarado: o repositorio ja entrega `maskedPan` no
 *     formato `****1234` proveniente do value object `MaskedPan`
 *     persistido (req 4.5).
 *   - Tipos compartilhados sao importados de `src/shared/types.ts` —
 *     fonte unica, nao redefinir.
 */

import { PrismaClient } from '@prisma/client';

import { TransactionStatus } from '../../shared/enums.js';
import { prisma as defaultPrisma } from '../../infra/persistence/prisma.js';
import {
  TransactionRepository,
  transactionRepository as defaultRepo,
} from '../../infra/persistence/transaction.repo.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  ReceiptError,
  ReceiptPayload,
} from '../../shared/types.js';

/**
 * Linha minima da tabela `merchants` consumida pelo servico. Reflete o
 * schema declarado em `prisma/schema.prisma`. Nao importamos o tipo
 * gerado pelo Prisma porque, neste ambiente, `@prisma/client` e
 * exportado como `any` (ver nota tecnica em `transaction.repo.ts`).
 */
interface MerchantRow {
  id: string;
  name: string;
  receiptTemplateId: string | null;
}

/**
 * Receipt Service.
 *
 * Cobre:
 *   - req 4.1: payload para APPROVED/VOIDED;
 *   - req 4.2: 409 NOT_AVAILABLE para DECLINED/PENDING (e SETTLED — ver
 *     TODO abaixo);
 *   - req 4.3: saida em JSON via {@link ReceiptPayload};
 *   - req 4.4: template do merchant (`receiptTemplateId`) ou null;
 *   - req 4.5: PAN mascarado last-4 (`****1234`) ja vindo do repo.
 */
export class ReceiptService {
  private readonly repo: TransactionRepository;
  private readonly prisma: PrismaClient;

  public constructor(
    repo: TransactionRepository = defaultRepo,
    prisma: PrismaClient = defaultPrisma,
  ) {
    this.repo = repo;
    this.prisma = prisma;
  }

  /**
   * Compoe o recibo de uma transacao. Tenant isolation e garantido
   * pelo `findById(id, merchantId)` do repositorio (req 6.4).
   *
   * Status handling (req 4.1, 4.2):
   *   - APPROVED, VOIDED  -> recibo emitido;
   *   - DECLINED, PENDING -> 409 NOT_AVAILABLE;
   *   - SETTLED           -> 409 NOT_AVAILABLE (fiel ao requisito atual;
   *     ver TODO logo abaixo).
   *
   * @param transactionId ID da transacao alvo.
   * @param merchantId    Merchant tenant (vindo do JWT).
   * @returns `Result<ReceiptPayload, ReceiptError>` — domain errors
   * tipados, sem excecoes (design.md "Domain errors are returned as
   * typed Result").
   */
  public async getReceipt(
    transactionId: string,
    merchantId: string,
  ): Promise<Result<ReceiptPayload, ReceiptError>> {
    // 1. Lookup com tenant isolation (req 6.4 + 4.1).
    const tx = await this.repo.findById(transactionId, merchantId);
    if (tx === null) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }

    // 2. State guard (req 4.1, 4.2).
    //
    // O design.md diz "APPROVED or VOIDED". Para SETTLED — que e um
    // estado pos-conciliacao — emitir recibo faz sentido funcional,
    // pois a transacao foi aprovada e liquidada. Porem, para ficar
    // fiel ao requisito atual e ao design, retornamos 409 tambem para
    // SETTLED.
    //
    // TODO(receipt): revisar se SETTLED deve emitir recibo (similar a
    // APPROVED). Requer atualizacao explicita em requirements.md /
    // design.md antes de mudar o comportamento aqui.
    if (
      tx.status !== TransactionStatus.APPROVED &&
      tx.status !== TransactionStatus.VOIDED
    ) {
      return err({
        code: 'NOT_AVAILABLE',
        currentStatus: tx.status,
        httpStatus: 409,
      });
    }

    // 3. Lookup merchant para nome + template (req 4.4).
    const merchant: MerchantRow | null = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, receiptTemplateId: true },
    });

    // Defensivo: a transacao so existe se o merchant existe (FK), mas
    // se por alguma razao a row sumir entre as duas queries, tratamos
    // como NOT_FOUND em vez de explodir.
    if (merchant === null) {
      return err({ code: 'NOT_FOUND', httpStatus: 404 });
    }

    // 4. Compose payload (req 4.3, 4.5).
    const payload: ReceiptPayload = {
      transactionId: tx.id,
      merchantName: merchant.name,
      terminalId: tx.terminalId,
      amount: tx.amount,
      currency: tx.currency,
      paymentMethodType: tx.paymentMethodType,
      // PAN ja vem mascarado (`****1234`) do repo / value object — nao
      // re-mascarar (req 4.5).
      maskedPan: tx.maskedPan,
      authorizationCode: tx.authorizationCode,
      // `createdAt` ja e ISO 8601 string (ver `toTransactionRecord`
      // em transaction.repo.ts).
      transactionTimestamp: tx.createdAt,
      receiptTemplate: merchant.receiptTemplateId ?? null,
    };

    return ok(payload);
  }
}

/** Singleton padrao para reuso pelas rotas HTTP. */
export const receiptService = new ReceiptService();
