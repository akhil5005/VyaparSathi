import { Prisma, type NoteReason, type NoteType, type SupplyType } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { D, round2, round3, sum, ZERO, type Numeric } from '../../lib/money.js';
import { financialYearOf } from '../../lib/financialYear.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { allocateDocumentNumber } from '../invoices/numbering.js';
import { computeInvoiceTotals, computeLine } from '../invoices/tax.js';
import { movingAverageCost } from '../purchases/costing.js';
import type { RequestContext } from '../auth/auth.service.js';
import type { listNotesQuerySchema } from './creditNote.schemas.js';

type ListNotesFilter = z.infer<typeof listNotesQuerySchema>;

export interface NoteItemInput {
  invoiceItemId: string;
  quantity: Numeric;
  /// Defaults to the original line's rate. For a rate-reduction note this is
  /// the *difference* per unit, not the new price.
  rate?: Numeric;
}

export interface CreateNoteInput {
  noteType: NoteType;
  againstSalesInvoiceId?: string;
  againstPurchaseInvoiceId?: string;
  reason: NoteReason;
  reasonNote?: string;
  noteDate?: Date;
  items: NoteItemInput[];
  affectsStock?: boolean;
  issue?: boolean;
}

/**
 * Whether a reason implies goods physically moved.
 *
 * A return puts reams back on the shelf; a rate correction is money only. Both
 * are credit notes, and confusing them silently corrupts stock — so the default
 * is derived from the reason rather than left to whoever fills the form.
 */
const REASONS_THAT_MOVE_GOODS = new Set<NoteReason>([
  'SALES_RETURN',
  'PURCHASE_RETURN',
  'DAMAGED_GOODS',
  'QUANTITY_SHORTAGE',
]);

interface PreparedNoteLine {
  lineNumber: number;
  invoiceItemId: string;
  productId: string;
  productName: string;
  hsnCode: string;
  quantity: Prisma.Decimal;
  unitId: string;
  unitName: string;
  uqc: string;
  conversionToBase: Prisma.Decimal;
  baseQuantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  computed: ReturnType<typeof computeLine>;
  /// Cost the goods were carried at, for the stock movement.
  costPerBaseUnit: Prisma.Decimal | null;
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

async function prepareNote(businessId: string, input: CreateNoteInput) {
  const isAgainstSale = input.againstSalesInvoiceId !== undefined;

  // Conventional bookkeeping: a supplier's credit note is recorded in our books
  // as a debit note against them. Keeping one canonical direction per side
  // means the ledger sign is never ambiguous.
  if (!isAgainstSale && input.noteType === 'CREDIT_NOTE') {
    throw badRequest(
      'A credit note is issued against a sale. To record goods returned to a supplier — or a ' +
        "credit note they sent you — raise a debit note against the purchase instead.",
    );
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business not found');

  const noteDate = input.noteDate ?? new Date();

  // ---- Load the original document ----
  const salesInvoice = isAgainstSale
    ? await prisma.salesInvoice.findFirst({
        where: { id: input.againstSalesInvoiceId!, businessId },
        include: { items: true, party: true },
      })
    : null;

  const purchaseInvoice = !isAgainstSale
    ? await prisma.purchaseInvoice.findFirst({
        where: { id: input.againstPurchaseInvoiceId!, businessId },
        include: { items: true, party: true },
      })
    : null;

  const original = salesInvoice ?? purchaseInvoice;
  if (!original) throw notFound(isAgainstSale ? 'Invoice not found' : 'Purchase not found');
  if (original.status !== 'ISSUED') {
    throw badRequest(
      `That ${isAgainstSale ? 'invoice' : 'purchase'} is ${original.status.toLowerCase()}. ` +
        'A note can only be raised against an issued document.',
    );
  }

  const originalItems = salesInvoice ? salesInvoice.items : purchaseInvoice!.items;
  const party = salesInvoice ? salesInvoice.party : purchaseInvoice!.party;
  const supplyType: SupplyType = original.supplyType;

  const originalNumber = salesInvoice
    ? salesInvoice.invoiceNumber
    : purchaseInvoice!.supplierInvoiceNumber;
  const originalDate = salesInvoice
    ? salesInvoice.invoiceDate
    : purchaseInvoice!.supplierInvoiceDate;

  if (noteDate < originalDate) {
    throw badRequest('A note cannot be dated before the document it is raised against');
  }

  // ---- How much of each line has already been credited ----
  // Without this ceiling you can credit the same ten reams three times over,
  // and both the stock and the tax reversal are wrong.
  const priorItems = await prisma.creditDebitNoteItem.findMany({
    where: {
      note: {
        businessId,
        status: 'ISSUED',
        affectsStock: true,
        ...(isAgainstSale
          ? { againstSalesInvoiceId: input.againstSalesInvoiceId }
          : { againstPurchaseInvoiceId: input.againstPurchaseInvoiceId }),
      },
    },
    select: { productId: true, quantity: true },
  });

  const affectsStock = input.affectsStock ?? REASONS_THAT_MOVE_GOODS.has(input.reason);

  const lines: PreparedNoteLine[] = [];
  const seenItems = new Set<string>();
  /// Quantities claimed earlier in *this* request, so two lines for the same
  /// product in one note cannot together exceed what was invoiced.
  const claimedInThisNote = new Map<string, Prisma.Decimal>();

  for (const [index, item] of input.items.entries()) {
    const lineNumber = index + 1;

    const originalLine = originalItems.find((l) => l.id === item.invoiceItemId);
    if (!originalLine) {
      throw badRequest(
        `Line ${lineNumber}: that line does not belong to ${originalNumber ?? 'the document'}`,
      );
    }
    if (seenItems.has(item.invoiceItemId)) {
      throw badRequest(`Line ${lineNumber}: the same invoice line appears twice`);
    }
    seenItems.add(item.invoiceItemId);

    const quantity = round3(D(item.quantity));

    // Only quantity-bearing notes are capped — a rate correction credits money
    // against the full original quantity and is not a second return.
    //
    // The ceiling is per *product across the whole invoice*, not per line: an
    // invoice can carry the same product on two lines (two rates, two batches),
    // and note items don't record which line they came from. Summing both sides
    // by product is the comparison that stays correct in that case.
    if (affectsStock) {
      const invoicedForProduct = sum(
        originalItems
          .filter((l) => l.productId === originalLine.productId)
          .map((l) => D(l.quantity)),
      );
      const creditedPreviously = sum(
        priorItems.filter((p) => p.productId === originalLine.productId).map((p) => D(p.quantity)),
      );
      const claimedHere = claimedInThisNote.get(originalLine.productId) ?? ZERO();

      const remaining = invoicedForProduct.minus(creditedPreviously).minus(claimedHere);
      if (quantity.greaterThan(remaining)) {
        throw badRequest(
          `Line ${lineNumber}: only ${remaining.toString()} ${originalLine.unitName} of ` +
            `"${originalLine.productName}" remain to be returned (invoiced ` +
            `${invoicedForProduct.toString()}, already credited ${creditedPreviously.toString()}).`,
        );
      }

      claimedInThisNote.set(originalLine.productId, claimedHere.plus(quantity));
    }

    // The rate defaults to the original; a rate-difference note supplies the gap.
    const rate = item.rate !== undefined ? D(item.rate) : D(originalLine.rate);

    // ── The rule that matters ────────────────────────────────────────────
    // Tax comes from the ORIGINAL line, never from today's HSN master. Goods
    // sold at 12% must be credited at 12% even if the slab has since changed,
    // or the reversal won't match the return that reported the sale.
    const gstRate = supplyType === 'INTRA_STATE'
      ? D(originalLine.cgstRate).plus(D(originalLine.sgstRate))
      : D(originalLine.igstRate);

    const computed = computeLine(
      { quantity, rate },
      { gstRate, cessRate: D(originalLine.cessRate) },
      supplyType,
    );

    lines.push({
      lineNumber,
      invoiceItemId: originalLine.id,
      productId: originalLine.productId,
      productName: originalLine.productName,
      hsnCode: originalLine.hsnCode,
      quantity,
      unitId: originalLine.unitId,
      unitName: originalLine.unitName,
      uqc: originalLine.uqc,
      conversionToBase: D(originalLine.conversionToBase),
      baseQuantity: round3(quantity.times(D(originalLine.conversionToBase))),
      rate,
      computed,
      costPerBaseUnit:
        'costPerBaseUnit' in originalLine && originalLine.costPerBaseUnit !== null
          ? D(originalLine.costPerBaseUnit)
          : 'landedCostPerBaseUnit' in originalLine && originalLine.landedCostPerBaseUnit !== null
            ? D(originalLine.landedCostPerBaseUnit)
            : null,
    });
  }

  const totals = computeInvoiceTotals(lines.map((l) => l.computed));

  return {
    business,
    party,
    supplyType,
    noteDate,
    affectsStock,
    isAgainstSale,
    originalNumber,
    originalDate,
    lines,
    totals,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createNote(
  businessId: string,
  userId: string,
  input: CreateNoteInput,
  ctx: RequestContext,
) {
  const prepared = await prepareNote(businessId, input);
  const { business, party, supplyType, noteDate, affectsStock, isAgainstSale, lines, totals } =
    prepared;

  const shouldIssue = input.issue !== false;
  const financialYear = financialYearOf(noteDate, business.fyStartMonth);

  const note = await prisma.$transaction(
    async (tx) => {
      const { number: noteNumber } = await allocateDocumentNumber(
        tx,
        businessId,
        input.noteType,
        financialYear,
      );

      const created = await tx.creditDebitNote.create({
        data: {
          businessId,
          noteNumber,
          financialYear,
          noteType: input.noteType,
          reason: input.reason,
          reasonNote: input.reasonNote ?? null,
          status: shouldIssue ? 'ISSUED' : 'DRAFT',
          noteDate,

          partyId: party.id,
          partyName: party.displayName,
          partyGstin: party.gstin,
          partyStateCode: party.stateCode,

          againstSalesInvoiceId: input.againstSalesInvoiceId ?? null,
          againstPurchaseInvoiceId: input.againstPurchaseInvoiceId ?? null,
          originalInvoiceNumber: prepared.originalNumber,
          originalInvoiceDate: prepared.originalDate,

          supplyType,
          taxableValue: totals.taxableValue,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,

          affectsStock,
          createdById: userId,
          issuedAt: shouldIssue ? new Date() : null,

          items: {
            create: lines.map((line) => ({
              lineNumber: line.lineNumber,
              productId: line.productId,
              productName: line.productName,
              hsnCode: line.hsnCode,
              quantity: line.quantity,
              unitId: line.unitId,
              unitName: line.unitName,
              uqc: line.uqc,
              conversionToBase: line.conversionToBase,
              baseQuantity: line.baseQuantity,
              rate: line.rate,
              taxableValue: line.computed.taxableValue,
              cgstRate: line.computed.cgstRate,
              cgstAmount: line.computed.cgstAmount,
              sgstRate: line.computed.sgstRate,
              sgstAmount: line.computed.sgstAmount,
              igstRate: line.computed.igstRate,
              igstAmount: line.computed.igstAmount,
              cessRate: line.computed.cessRate,
              cessAmount: line.computed.cessAmount,
              lineTotal: line.computed.lineTotal,
            })),
          },
        },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });

      if (shouldIssue) {
        await applyNoteSideEffects(tx, {
          businessId,
          userId,
          note: created,
          lines,
          party,
          affectsStock,
          isAgainstSale,
          noteType: input.noteType,
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: shouldIssue ? 'note.issue' : 'note.draft',
          entityType: 'CreditDebitNote',
          entityId: created.id,
          after: {
            noteNumber,
            noteType: input.noteType,
            reason: input.reason,
            against: prepared.originalNumber,
            grandTotal: totals.grandTotal.toString(),
          },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 },
  );

  return { note, affectsStock };
}

/**
 * Ledger and stock for an issued note.
 *
 * Direction, using the schema's "positive balance = they owe us" convention:
 *
 *   CREDIT_NOTE  vs sale     — customer owes less   → balance down, ledger credit
 *   DEBIT_NOTE   vs sale     — customer owes more   → balance up,   ledger debit
 *   DEBIT_NOTE   vs purchase — we owe supplier less → balance up,   ledger debit
 */
async function applyNoteSideEffects(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    userId: string;
    note: { id: string; noteNumber: string; noteDate: Date; grandTotal: Prisma.Decimal };
    lines: PreparedNoteLine[];
    party: { id: string; displayName: string; openingBalance: Prisma.Decimal };
    affectsStock: boolean;
    isAgainstSale: boolean;
    noteType: NoteType;
  },
) {
  const { businessId, userId, note, lines, party, affectsStock, isAgainstSale, noteType } = args;

  const reducesReceivable = isAgainstSale && noteType === 'CREDIT_NOTE';
  const delta = reducesReceivable ? note.grandTotal.negated() : note.grandTotal;

  // ---- Stock ----
  if (affectsStock) {
    // A sales credit note brings goods back in; a purchase debit note sends
    // them back to the mill.
    const inward = isAgainstSale;

    for (const line of lines) {
      if (inward) {
        // Returned goods re-enter at the cost they left at, blended into the
        // running average — same lock-read-write shape as a purchase receipt.
        const locked = await tx.productStock.upsert({
          where: { productId: line.productId },
          create: {
            productId: line.productId,
            businessId,
            quantityOnHand: 0,
            avgCostPerBaseUnit: 0,
            lastMovementAt: note.noteDate,
          },
          update: { lastMovementAt: note.noteDate },
        });

        const newAverage = line.costPerBaseUnit
          ? movingAverageCost(
              locked.quantityOnHand,
              locked.avgCostPerBaseUnit,
              line.baseQuantity,
              line.costPerBaseUnit,
            )
          : D(locked.avgCostPerBaseUnit);

        const updated = await tx.productStock.update({
          where: { productId: line.productId },
          data: {
            quantityOnHand: { increment: line.baseQuantity },
            avgCostPerBaseUnit: newAverage,
          },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            productId: line.productId,
            movementType: 'SALES_RETURN_IN',
            movementDate: note.noteDate,
            baseQuantity: line.baseQuantity,
            ratePerBaseUnit: line.costPerBaseUnit,
            balanceAfter: updated.quantityOnHand,
            referenceType: 'CREDIT_NOTE',
            referenceId: note.id,
            referenceNumber: note.noteNumber,
            createdById: userId,
          },
        });
      } else {
        const updated = await tx.productStock.update({
          where: { productId: line.productId },
          data: {
            quantityOnHand: { decrement: line.baseQuantity },
            lastMovementAt: note.noteDate,
          },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            productId: line.productId,
            movementType: 'PURCHASE_RETURN_OUT',
            movementDate: note.noteDate,
            baseQuantity: line.baseQuantity.negated(),
            ratePerBaseUnit: line.costPerBaseUnit,
            balanceAfter: updated.quantityOnHand,
            referenceType: 'DEBIT_NOTE',
            referenceId: note.id,
            referenceNumber: note.noteNumber,
            createdById: userId,
          },
        });
      }
    }
  }

  // ---- Ledger ----
  const balance = await tx.partyBalance.upsert({
    where: { partyId: party.id },
    create: {
      partyId: party.id,
      currentBalance: D(party.openingBalance).plus(delta),
      lastEntryAt: note.noteDate,
    },
    update: { currentBalance: { increment: delta }, lastEntryAt: note.noteDate },
  });

  await tx.ledgerEntry.create({
    data: {
      businessId,
      partyId: party.id,
      entryDate: note.noteDate,
      voucherType: noteType === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
      voucherId: note.id,
      voucherNumber: note.noteNumber,
      debit: delta.greaterThan(0) ? delta : 0,
      credit: delta.lessThan(0) ? delta.abs() : 0,
      runningBalance: balance.currentBalance,
      narration: `${noteType === 'CREDIT_NOTE' ? 'Credit' : 'Debit'} note ${note.noteNumber}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelNote(
  businessId: string,
  userId: string,
  noteId: string,
  reason: string,
  ctx: RequestContext,
) {
  const note = await prisma.creditDebitNote.findFirst({
    where: { id: noteId, businessId },
    include: { items: true },
  });
  if (!note) throw notFound('Note not found');
  if (note.status === 'CANCELLED') throw conflict('Note is already cancelled');

  if (note.status === 'DRAFT') {
    await prisma.creditDebitNote.delete({ where: { id: noteId } });
    return { cancelled: true, deleted: true };
  }

  const cancelledAt = new Date();
  const isAgainstSale = note.againstSalesInvoiceId !== null;
  const reducesReceivable = isAgainstSale && note.noteType === 'CREDIT_NOTE';
  // Undo whatever the note did.
  const reversalDelta = reducesReceivable ? D(note.grandTotal) : D(note.grandTotal).negated();

  await prisma.$transaction(
    async (tx) => {
      if (note.affectsStock) {
        for (const item of note.items) {
          const inwardOriginally = isAgainstSale;
          const updated = await tx.productStock.update({
            where: { productId: item.productId },
            data: {
              quantityOnHand: inwardOriginally
                ? { decrement: item.baseQuantity }
                : { increment: item.baseQuantity },
              lastMovementAt: cancelledAt,
            },
          });

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: item.productId,
              movementType: inwardOriginally ? 'ADJUSTMENT_OUT' : 'ADJUSTMENT_IN',
              movementDate: cancelledAt,
              baseQuantity: inwardOriginally
                ? D(item.baseQuantity).negated()
                : D(item.baseQuantity),
              balanceAfter: updated.quantityOnHand,
              referenceType: 'NOTE_CANCELLED',
              referenceId: note.id,
              referenceNumber: note.noteNumber,
              notes: `Cancellation of ${note.noteNumber}: ${reason}`,
              createdById: userId,
            },
          });
        }
      }

      const balance = await tx.partyBalance.update({
        where: { partyId: note.partyId },
        data: { currentBalance: { increment: reversalDelta }, lastEntryAt: cancelledAt },
      });

      await tx.ledgerEntry.create({
        data: {
          businessId,
          partyId: note.partyId,
          entryDate: cancelledAt,
          voucherType: 'ADJUSTMENT',
          voucherId: note.id,
          voucherNumber: note.noteNumber,
          debit: reversalDelta.greaterThan(0) ? reversalDelta : 0,
          credit: reversalDelta.lessThan(0) ? reversalDelta.abs() : 0,
          runningBalance: balance.currentBalance,
          narration: `Cancellation of note ${note.noteNumber}: ${reason}`,
        },
      });

      await tx.creditDebitNote.update({
        where: { id: noteId },
        data: { status: 'CANCELLED', reasonNote: reason },
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'note.cancel',
          entityType: 'CreditDebitNote',
          entityId: noteId,
          after: { reason },
          ipAddress: ctx.ipAddress ?? null,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
  );

  return { cancelled: true, deleted: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function previewNote(businessId: string, input: CreateNoteInput) {
  const prepared = await prepareNote(businessId, input);
  return {
    noteType: input.noteType,
    reason: input.reason,
    affectsStock: prepared.affectsStock,
    supplyType: prepared.supplyType,
    party: { id: prepared.party.id, displayName: prepared.party.displayName },
    against: { number: prepared.originalNumber, date: prepared.originalDate },
    lines: prepared.lines.map((l) => ({
      lineNumber: l.lineNumber,
      productName: l.productName,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      unitName: l.unitName,
      rate: l.rate,
      ...l.computed,
    })),
    totals: prepared.totals,
  };
}

export async function getNote(businessId: string, noteId: string) {
  const note = await prisma.creditDebitNote.findFirst({
    where: { id: noteId, businessId },
    include: {
      items: { orderBy: { lineNumber: 'asc' } },
      party: { select: { id: true, displayName: true, gstin: true, phone: true } },
      againstSalesInvoice: {
        select: { id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true },
      },
      againstPurchaseInvoice: {
        select: { id: true, purchaseNumber: true, supplierInvoiceNumber: true, grandTotal: true },
      },
    },
  });
  if (!note) throw notFound('Note not found');
  return note;
}

export async function listNotes(businessId: string, filter: ListNotesFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.CreditDebitNoteWhereInput = {
    businessId,
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.noteType ? { noteType: filter.noteType } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
    ...(filter.fromDate || filter.toDate
      ? {
          noteDate: {
            ...(filter.fromDate ? { gte: filter.fromDate } : {}),
            ...(filter.toDate ? { lte: filter.toDate } : {}),
          },
        }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { noteNumber: { contains: filter.search, mode: 'insensitive' } },
            { partyName: { contains: filter.search, mode: 'insensitive' } },
            { originalInvoiceNumber: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total, aggregate] = await Promise.all([
    prisma.creditDebitNote.findMany({
      where,
      orderBy: [{ noteDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.creditDebitNote.count({ where }),
    prisma.creditDebitNote.aggregate({ where, _sum: { grandTotal: true, taxableValue: true } }),
  ]);

  return {
    notes: rows,
    total,
    page,
    pageSize,
    totalValue: D(aggregate._sum.grandTotal ?? 0),
    totalTaxable: D(aggregate._sum.taxableValue ?? 0),
  };
}

/**
 * How much of each line on an invoice is still available to credit.
 *
 * The UI needs this to cap the quantity box — it is far better to stop a
 * double return at the form than to reject it after the fact.
 */
export async function getCreditableLines(businessId: string, salesInvoiceId: string) {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: salesInvoiceId, businessId },
    include: { items: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!invoice) throw notFound('Invoice not found');

  // Only goods-moving notes consume return quota — a rate correction is money
  // only and must not reduce what can still be sent back.
  const priorItems = await prisma.creditDebitNoteItem.findMany({
    where: {
      note: {
        businessId,
        status: 'ISSUED',
        affectsStock: true,
        againstSalesInvoiceId: salesInvoiceId,
      },
    },
    select: { productId: true, quantity: true },
  });

  return {
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      partyName: invoice.partyName,
    },
    lines: invoice.items.map((item) => {
      // Both sides are summed per product across the invoice — see the note in
      // prepareNote on why the ceiling is not per line.
      const invoicedForProduct = sum(
        invoice.items.filter((l) => l.productId === item.productId).map((l) => D(l.quantity)),
      );
      const credited = sum(
        priorItems.filter((p) => p.productId === item.productId).map((p) => D(p.quantity)),
      );
      const productRemaining = invoicedForProduct.minus(credited);

      return {
        invoiceItemId: item.id,
        productId: item.productId,
        productName: item.productName,
        unitName: item.unitName,
        invoicedQuantity: D(item.quantity),
        alreadyCredited: credited,
        /// Capped at this line's own quantity so the UI never offers more on a
        /// single line than that line carried.
        creditableQuantity: productRemaining.lessThan(D(item.quantity))
          ? productRemaining
          : D(item.quantity),
        rate: D(item.rate),
      };
    }),
  };
}

/**
 * Note totals for a period, split by which side they affect.
 *
 * Used by the GST summary: credit notes against sales reduce output tax, and
 * debit notes against purchases reverse input credit. Leaving them out
 * overstates both sides of the liability.
 */
export async function getNoteTaxTotals(businessId: string, fromDate: Date, toDate: Date) {
  const [salesSide, purchaseSide] = await Promise.all([
    prisma.creditDebitNote.groupBy({
      by: ['noteType'],
      where: {
        businessId,
        status: 'ISSUED',
        againstSalesInvoiceId: { not: null },
        noteDate: { gte: fromDate, lte: toDate },
      },
      _sum: { totalCgst: true, totalSgst: true, totalIgst: true, totalCess: true, taxableValue: true },
    }),
    prisma.creditDebitNote.aggregate({
      where: {
        businessId,
        status: 'ISSUED',
        againstPurchaseInvoiceId: { not: null },
        noteDate: { gte: fromDate, lte: toDate },
      },
      _sum: { totalCgst: true, totalSgst: true, totalIgst: true, totalCess: true, taxableValue: true },
    }),
  ]);

  const credit = salesSide.find((r) => r.noteType === 'CREDIT_NOTE')?._sum;
  const debit = salesSide.find((r) => r.noteType === 'DEBIT_NOTE')?._sum;

  const head = (row: typeof credit) => ({
    cgst: D(row?.totalCgst ?? 0),
    sgst: D(row?.totalSgst ?? 0),
    igst: D(row?.totalIgst ?? 0),
    cess: D(row?.totalCess ?? 0),
    taxableValue: D(row?.taxableValue ?? 0),
  });

  return {
    /// Reduces output tax.
    salesCreditNotes: head(credit),
    /// Increases output tax.
    salesDebitNotes: head(debit),
    /// Reverses input credit.
    purchaseReturns: head(purchaseSide._sum),
  };
}
