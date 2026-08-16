import type { DocumentType, Prisma, PrismaClient } from '@prisma/client';
import { badRequest } from '../../lib/errors.js';

export type TxClient = Prisma.TransactionClient | PrismaClient;

/// GST caps document numbers at 16 characters.
const MAX_DOCUMENT_NUMBER_LENGTH = 16;

const DEFAULT_PREFIXES: Partial<Record<DocumentType, string>> = {
  SALES_INVOICE: 'INV/',
  CREDIT_NOTE: 'CN/',
  DEBIT_NOTE: 'DN/',
  DELIVERY_CHALLAN: 'DC/',
  PURCHASE_INVOICE: 'PUR/',
  PAYMENT_RECEIPT: 'RCP/',
  PAYMENT_VOUCHER: 'PAY/',
  PURCHASE_RETURN: 'PR/',
  QUOTATION: 'QT/',
};

/**
 * Allocates the next document number for a financial year.
 *
 * **Must be called inside a transaction.** Prisma's `{ increment: 1 }` compiles
 * to `UPDATE … SET "nextNumber" = "nextNumber" + 1 … RETURNING *`, which takes a
 * row lock held until the transaction commits. That gives us the two properties
 * GST actually requires:
 *
 *   - **Unique** — two concurrent bills serialise on the row instead of both
 *     reading the same value.
 *   - **Gap-free** — if the surrounding transaction rolls back, the increment
 *     rolls back with it and the number is handed to the next caller.
 *
 * Allocating outside a transaction, or allocating before the rest of the
 * invoice is known to be valid, reintroduces gaps. Call this last.
 */
export async function allocateDocumentNumber(
  tx: TxClient,
  businessId: string,
  documentType: DocumentType,
  financialYear: string,
): Promise<{ number: string; sequenceValue: number }> {
  let sequence = await tx.numberSequence.findUnique({
    where: {
      businessId_documentType_financialYear: { businessId, documentType, financialYear },
    },
  });

  // First document of a new financial year. Carry the previous year's format
  // forward so the numbering style stays consistent year to year.
  if (!sequence) {
    const previous = await tx.numberSequence.findFirst({
      where: { businessId, documentType },
      orderBy: { financialYear: 'desc' },
    });

    sequence = await tx.numberSequence.create({
      data: {
        businessId,
        documentType,
        financialYear,
        prefix: previous?.prefix ?? DEFAULT_PREFIXES[documentType] ?? '',
        suffix: previous?.suffix ?? '',
        padding: previous?.padding ?? 4,
        nextNumber: 1,
      },
    });
  }

  const updated = await tx.numberSequence.update({
    where: { id: sequence.id },
    data: { nextNumber: { increment: 1 } },
  });

  // `update` returns the row *after* the increment, so the value we just
  // claimed is one less.
  const allocated = updated.nextNumber - 1;

  const number = `${updated.prefix}${String(allocated).padStart(updated.padding, '0')}${updated.suffix}`;

  if (number.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    throw badRequest(
      `Generated document number "${number}" is ${number.length} characters. ` +
        `GST allows a maximum of ${MAX_DOCUMENT_NUMBER_LENGTH} — shorten the prefix or suffix in settings.`,
    );
  }

  return { number, sequenceValue: allocated };
}

/**
 * Shows what the next number will look like without consuming it — for the
 * "new invoice" screen, which should display the number before saving.
 */
export async function peekDocumentNumber(
  db: TxClient,
  businessId: string,
  documentType: DocumentType,
  financialYear: string,
): Promise<string> {
  const sequence = await db.numberSequence.findUnique({
    where: {
      businessId_documentType_financialYear: { businessId, documentType, financialYear },
    },
  });

  const prefix = sequence?.prefix ?? DEFAULT_PREFIXES[documentType] ?? '';
  const suffix = sequence?.suffix ?? '';
  const padding = sequence?.padding ?? 4;
  const next = sequence?.nextNumber ?? 1;

  return `${prefix}${String(next).padStart(padding, '0')}${suffix}`;
}
