import { Prisma, type PaymentDirection, type PaymentMode } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { D, round2, ZERO, type Numeric } from '../../lib/money.js';
import { financialYearOf } from '../../lib/financialYear.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { allocateDocumentNumber } from '../invoices/numbering.js';
import type { RequestContext } from '../auth/auth.service.js';
import {
  allocateFifo,
  summariseAgeing,
  totalAllocated,
  validateExplicitAllocations,
  type AllocatableInvoice,
  type Allocation,
} from './allocation.js';
import type { listPaymentsQuerySchema, outstandingQuerySchema } from './payment.schemas.js';

type ListPaymentsFilter = z.infer<typeof listPaymentsQuerySchema>;
type OutstandingFilter = z.infer<typeof outstandingQuerySchema>;

/**
 * Service-level input. Hand-written rather than inferred from the Zod schema so
 * money fields accept a number or a string — the HTTP layer normalises to
 * strings, but a direct caller shouldn't have to.
 */
export interface ChequeDetailsInput {
  chequeNumber: string;
  bankName: string;
  branchName?: string;
  chequeDate: Date;
}

export interface AllocationRequestInput {
  invoiceId: string;
  amount: Numeric;
}

export interface RecordPaymentInput {
  partyId: string;
  direction: PaymentDirection;
  amount: Numeric;
  mode: PaymentMode;
  paymentDate?: Date;
  referenceNumber?: string;
  bankName?: string;
  notes?: string;
  cheque?: ChequeDetailsInput;
  /// Omit to settle oldest bills first; supply to hand-pick.
  allocations?: AllocationRequestInput[];
  /// false takes the money purely on account.
  autoAllocate?: boolean;
}

export interface AllocateInput {
  allocations?: AllocationRequestInput[];
  auto?: boolean;
}

/**
 * A receipt reduces what the customer owes us; a payment reduces what we owe a
 * supplier. The schema's sign convention is "positive balance = they owe us",
 * so a receipt moves the balance down and a payment moves it up.
 */
const balanceDelta = (direction: PaymentDirection, amount: Prisma.Decimal): Prisma.Decimal =>
  direction === 'RECEIPT' ? amount.negated() : amount;

/**
 * Open bills for a party, oldest first.
 *
 * Receipts settle sales invoices; payments settle purchase invoices. Both use
 * a column-to-column comparison so the filter runs in SQL rather than pulling
 * every invoice back to filter in memory.
 */
async function openInvoices(
  tx: Prisma.TransactionClient,
  businessId: string,
  partyId: string,
  direction: PaymentDirection,
): Promise<AllocatableInvoice[]> {
  if (direction === 'RECEIPT') {
    const rows = await tx.salesInvoice.findMany({
      where: {
        businessId,
        partyId,
        status: 'ISSUED',
        grandTotal: { gt: prisma.salesInvoice.fields.amountPaid },
      },
      orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, invoiceDate: true, grandTotal: true, amountPaid: true },
    });
    return rows.map((r) => ({
      id: r.id,
      invoiceDate: r.invoiceDate,
      amountDue: D(r.grandTotal).minus(D(r.amountPaid)),
    }));
  }

  const rows = await tx.purchaseInvoice.findMany({
    where: {
      businessId,
      partyId,
      status: 'ISSUED',
      grandTotal: { gt: prisma.purchaseInvoice.fields.amountPaid },
    },
    orderBy: [{ supplierInvoiceDate: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, supplierInvoiceDate: true, grandTotal: true, amountPaid: true },
  });
  return rows.map((r) => ({
    id: r.id,
    invoiceDate: r.supplierInvoiceDate,
    amountDue: D(r.grandTotal).minus(D(r.amountPaid)),
  }));
}

/// Applies a signed change to an invoice's paid amount, either direction.
async function bumpInvoicePaid(
  tx: Prisma.TransactionClient,
  direction: PaymentDirection,
  invoiceId: string,
  delta: Prisma.Decimal,
) {
  if (direction === 'RECEIPT') {
    await tx.salesInvoice.update({
      where: { id: invoiceId },
      data: { amountPaid: { increment: delta } },
    });
  } else {
    await tx.purchaseInvoice.update({
      where: { id: invoiceId },
      data: { amountPaid: { increment: delta } },
    });
  }
}

async function writeAllocations(
  tx: Prisma.TransactionClient,
  paymentId: string,
  direction: PaymentDirection,
  allocations: Allocation[],
) {
  for (const allocation of allocations) {
    await tx.paymentAllocation.create({
      data: {
        paymentId,
        ...(direction === 'RECEIPT'
          ? { salesInvoiceId: allocation.invoiceId }
          : { purchaseInvoiceId: allocation.invoiceId }),
        amount: allocation.amount,
      },
    });
    await bumpInvoicePaid(tx, direction, allocation.invoiceId, allocation.amount);
  }
}

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

export async function recordPayment(
  businessId: string,
  userId: string,
  input: RecordPaymentInput,
  ctx: RequestContext,
) {
  const party = await prisma.party.findFirst({ where: { id: input.partyId, businessId } });
  if (!party) throw notFound('Party not found');
  if (!party.isActive) throw badRequest(`"${party.displayName}" is inactive`);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { fyStartMonth: true },
  });

  const amount = round2(D(input.amount));
  const paymentDate = input.paymentDate ?? new Date();
  const financialYear = financialYearOf(paymentDate, business?.fyStartMonth ?? 4);
  const documentType = input.direction === 'RECEIPT' ? 'PAYMENT_RECEIPT' : 'PAYMENT_VOUCHER';

  const result = await prisma.$transaction(
    async (tx) => {
      // ── Serialization point ────────────────────────────────────────────────
      // Every payment for a party must touch this row, so updating it first
      // takes a lock held to commit. Two concurrent receipts for the same
      // customer therefore queue instead of both reading the same set of open
      // bills and double-allocating against them.
      const balance = await tx.partyBalance.upsert({
        where: { partyId: party.id },
        create: {
          partyId: party.id,
          currentBalance: D(party.openingBalance).plus(balanceDelta(input.direction, amount)),
          lastEntryAt: paymentDate,
        },
        update: {
          currentBalance: { increment: balanceDelta(input.direction, amount) },
          lastEntryAt: paymentDate,
        },
      });

      const { number: voucherNumber } = await allocateDocumentNumber(
        tx,
        businessId,
        documentType,
        financialYear,
      );

      // ── Cheque ────────────────────────────────────────────────────────────
      let chequeId: string | null = null;
      if (input.mode === 'CHEQUE' && input.cheque) {
        const duplicate = await tx.cheque.findFirst({
          where: { businessId, partyId: party.id, chequeNumber: input.cheque.chequeNumber },
          select: { id: true },
        });
        if (duplicate) {
          throw conflict(
            `Cheque ${input.cheque.chequeNumber} is already recorded for "${party.displayName}"`,
          );
        }
        const cheque = await tx.cheque.create({
          data: {
            businessId,
            partyId: party.id,
            direction: input.direction,
            chequeNumber: input.cheque.chequeNumber,
            bankName: input.cheque.bankName,
            branchName: input.cheque.branchName ?? null,
            chequeDate: input.cheque.chequeDate,
            amount,
            status: 'PENDING',
          },
        });
        chequeId = cheque.id;
      }

      // ── Allocation ────────────────────────────────────────────────────────
      const open = await openInvoices(tx, businessId, party.id, input.direction);

      let allocations: Allocation[] = [];
      if (input.allocations) {
        const validated = validateExplicitAllocations(amount, input.allocations, open);
        if (validated.issues.length > 0) {
          throw badRequest('Some allocations could not be applied', validated.issues);
        }
        allocations = validated.allocations;
      } else if (input.autoAllocate !== false) {
        allocations = allocateFifo(amount, open).allocations;
      }

      const unallocatedAmount = round2(amount.minus(totalAllocated(allocations)));

      const payment = await tx.payment.create({
        data: {
          businessId,
          voucherNumber,
          direction: input.direction,
          paymentDate,
          partyId: party.id,
          amount,
          mode: input.mode,
          referenceNumber: input.referenceNumber ?? input.cheque?.chequeNumber ?? null,
          bankName: input.bankName ?? input.cheque?.bankName ?? null,
          notes: input.notes ?? null,
          chequeId,
          unallocatedAmount,
          recordedById: userId,
        },
      });

      await writeAllocations(tx, payment.id, input.direction, allocations);

      // ── Ledger ────────────────────────────────────────────────────────────
      await tx.ledgerEntry.create({
        data: {
          businessId,
          partyId: party.id,
          entryDate: paymentDate,
          voucherType: input.direction === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT',
          voucherId: payment.id,
          voucherNumber,
          debit: input.direction === 'PAYMENT' ? amount : 0,
          credit: input.direction === 'RECEIPT' ? amount : 0,
          runningBalance: balance.currentBalance,
          narration:
            `${input.direction === 'RECEIPT' ? 'Received from' : 'Paid to'} ${party.displayName}` +
            ` by ${input.mode.toLowerCase().replace('_', ' ')}` +
            (input.cheque ? ` (cheque ${input.cheque.chequeNumber})` : ''),
        },
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: input.direction === 'RECEIPT' ? 'payment.receipt' : 'payment.payment',
          entityType: 'Payment',
          entityId: payment.id,
          after: {
            voucherNumber,
            party: party.displayName,
            amount: amount.toString(),
            mode: input.mode,
            allocatedTo: allocations.length,
          },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return { payment, allocations, balanceAfter: balance.currentBalance };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 },
  );

  return {
    payment: result.payment,
    allocatedTo: result.allocations,
    unallocated: result.payment.unallocatedAmount,
    partyBalanceAfter: result.balanceAfter,
  };
}

// ---------------------------------------------------------------------------
// Allocate money that is sitting on account
// ---------------------------------------------------------------------------

/**
 * Applies an existing payment's on-account balance to open bills. Used when a
 * customer paid a round figure in advance and the bills came later.
 */
export async function allocateExistingPayment(
  businessId: string,
  userId: string,
  paymentId: string,
  input: AllocateInput,
  ctx: RequestContext,
) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, businessId } });
  if (!payment) throw notFound('Payment not found');
  if (payment.reversedAt) throw conflict('This payment has been reversed');

  const available = round2(D(payment.unallocatedAmount));
  if (available.lessThanOrEqualTo(0)) {
    throw badRequest('This payment is fully allocated — there is nothing left on account');
  }

  return prisma.$transaction(
    async (tx) => {
      // Same serialization point as recordPayment.
      await tx.partyBalance.update({
        where: { partyId: payment.partyId },
        data: { lastEntryAt: new Date() },
      });

      const open = await openInvoices(tx, businessId, payment.partyId, payment.direction);

      let allocations: Allocation[];
      if (input.allocations) {
        const validated = validateExplicitAllocations(available, input.allocations, open);
        if (validated.issues.length > 0) {
          throw badRequest('Some allocations could not be applied', validated.issues);
        }
        allocations = validated.allocations;
      } else {
        allocations = allocateFifo(available, open).allocations;
      }

      if (allocations.length === 0) {
        throw badRequest('There are no open bills to allocate this against');
      }

      await writeAllocations(tx, payment.id, payment.direction, allocations);

      const applied = totalAllocated(allocations);
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { unallocatedAmount: { decrement: applied } },
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'payment.allocate',
          entityType: 'Payment',
          entityId: payment.id,
          after: { applied: applied.toString(), invoices: allocations.length },
          ipAddress: ctx.ipAddress ?? null,
        },
      });

      // Allocation moves money between buckets inside the party's account; the
      // party balance itself does not change, so no ledger entry is written.
      return { payment: updated, allocatedTo: allocations, applied };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
  );
}

/** Detaches one allocation, returning that money to the on-account pool. */
export async function removeAllocation(
  businessId: string,
  userId: string,
  paymentId: string,
  allocationId: string,
  ctx: RequestContext,
) {
  const allocation = await prisma.paymentAllocation.findFirst({
    where: { id: allocationId, paymentId, payment: { businessId } },
    include: { payment: true },
  });
  if (!allocation) throw notFound('Allocation not found');
  if (allocation.payment.reversedAt) throw conflict('This payment has been reversed');

  const invoiceId = allocation.salesInvoiceId ?? allocation.purchaseInvoiceId;
  if (!invoiceId) throw badRequest('Allocation is not linked to an invoice');

  await prisma.$transaction(async (tx) => {
    await bumpInvoicePaid(tx, allocation.payment.direction, invoiceId, D(allocation.amount).negated());
    await tx.paymentAllocation.delete({ where: { id: allocationId } });
    await tx.payment.update({
      where: { id: paymentId },
      data: { unallocatedAmount: { increment: allocation.amount } },
    });
    await tx.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'payment.unallocate',
        entityType: 'Payment',
        entityId: paymentId,
        before: { invoiceId, amount: allocation.amount.toString() },
        ipAddress: ctx.ipAddress ?? null,
      },
    });
  });

  return { removed: true };
}

// ---------------------------------------------------------------------------
// Reversal — shared by manual reversal and cheque bounce
// ---------------------------------------------------------------------------

/**
 * Undoes a payment's effects inside the caller's transaction.
 *
 * Payments are never deleted. The allocations are removed and the invoices
 * reopened, but the payment row survives with `reversedAt` set and a contra
 * ledger entry explains it — a payment that vanishes from the books is exactly
 * the thing an audit trail exists to prevent.
 */
async function applyReversal(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    userId: string;
    paymentId: string;
    reason: string;
    /// Bank charges recovered from the party on a bounce.
    extraCharge?: Prisma.Decimal;
    onDate: Date;
    voucherType: 'ADJUSTMENT' | 'CHEQUE_BOUNCE';
  },
) {
  const payment = await tx.payment.findUnique({
    where: { id: args.paymentId },
    include: { allocations: true, party: { select: { displayName: true } } },
  });
  if (!payment) throw notFound('Payment not found');
  if (payment.reversedAt) throw conflict('This payment has already been reversed');

  // Reopen every invoice this payment had settled.
  for (const allocation of payment.allocations) {
    const invoiceId = allocation.salesInvoiceId ?? allocation.purchaseInvoiceId;
    if (!invoiceId) continue;
    await bumpInvoicePaid(tx, payment.direction, invoiceId, D(allocation.amount).negated());
  }
  await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });

  const amount = D(payment.amount);
  const charge = args.extraCharge ?? ZERO();
  // Reversing the original delta, plus any bounce charge which the party now owes.
  const reversalDelta = balanceDelta(payment.direction, amount).negated().plus(charge);

  const balance = await tx.partyBalance.update({
    where: { partyId: payment.partyId },
    data: { currentBalance: { increment: reversalDelta }, lastEntryAt: args.onDate },
  });

  await tx.ledgerEntry.create({
    data: {
      businessId: args.businessId,
      partyId: payment.partyId,
      entryDate: args.onDate,
      voucherType: args.voucherType,
      voucherId: payment.id,
      voucherNumber: payment.voucherNumber,
      debit: payment.direction === 'RECEIPT' ? amount : 0,
      credit: payment.direction === 'PAYMENT' ? amount : 0,
      runningBalance: charge.isZero() ? balance.currentBalance : balance.currentBalance.minus(charge),
      narration: `Reversal of ${payment.voucherNumber}: ${args.reason}`,
    },
  });

  if (charge.greaterThan(0)) {
    await tx.ledgerEntry.create({
      data: {
        businessId: args.businessId,
        partyId: payment.partyId,
        entryDate: args.onDate,
        voucherType: args.voucherType,
        voucherId: payment.id,
        debit: charge,
        credit: 0,
        runningBalance: balance.currentBalance,
        narration: `Cheque return charges on ${payment.voucherNumber}`,
      },
    });
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      reversedAt: args.onDate,
      reversedReason: args.reason,
      unallocatedAmount: 0,
    },
  });

  await tx.auditLog.create({
    data: {
      businessId: args.businessId,
      userId: args.userId,
      action: args.voucherType === 'CHEQUE_BOUNCE' ? 'payment.cheque_bounce' : 'payment.reverse',
      entityType: 'Payment',
      entityId: payment.id,
      before: { amount: amount.toString(), allocations: payment.allocations.length },
      after: { reversed: true, reason: args.reason, charge: charge.toString() },
    },
  });

  return { payment, balanceAfter: balance.currentBalance };
}

export async function reversePayment(
  businessId: string,
  userId: string,
  paymentId: string,
  reason: string,
  ctx: RequestContext,
) {
  const exists = await prisma.payment.findFirst({
    where: { id: paymentId, businessId },
    select: { id: true },
  });
  if (!exists) throw notFound('Payment not found');

  return prisma.$transaction(
    async (tx) =>
      applyReversal(tx, {
        businessId,
        userId,
        paymentId,
        reason,
        onDate: new Date(),
        voucherType: 'ADJUSTMENT',
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
  );
}

export { applyReversal };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPayments(businessId: string, filter: ListPaymentsFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.PaymentWhereInput = {
    businessId,
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.direction ? { direction: filter.direction } : {}),
    ...(filter.mode ? { mode: filter.mode } : {}),
    ...(filter.includeReversed ? {} : { reversedAt: null }),
    ...(filter.unallocatedOnly ? { unallocatedAmount: { gt: 0 } } : {}),
    ...(filter.fromDate || filter.toDate
      ? {
          paymentDate: {
            ...(filter.fromDate ? { gte: filter.fromDate } : {}),
            ...(filter.toDate ? { lte: filter.toDate } : {}),
          },
        }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { voucherNumber: { contains: filter.search, mode: 'insensitive' } },
            { referenceNumber: { contains: filter.search, mode: 'insensitive' } },
            { party: { displayName: { contains: filter.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total, totals] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        party: { select: { id: true, displayName: true } },
        cheque: { select: { id: true, chequeNumber: true, chequeDate: true, status: true } },
        _count: { select: { allocations: true } },
      },
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amount: true, unallocatedAmount: true } }),
  ]);

  return {
    payments: rows,
    total,
    page,
    pageSize,
    totalAmount: D(totals._sum.amount ?? 0),
    totalOnAccount: D(totals._sum.unallocatedAmount ?? 0),
  };
}

export async function getPayment(businessId: string, paymentId: string) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, businessId },
    include: {
      party: { select: { id: true, displayName: true, phone: true } },
      cheque: true,
      recordedBy: { select: { id: true, fullName: true } },
      allocations: {
        include: {
          salesInvoice: {
            select: { id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true, amountPaid: true },
          },
          purchaseInvoice: {
            select: { id: true, purchaseNumber: true, supplierInvoiceNumber: true, supplierInvoiceDate: true, grandTotal: true, amountPaid: true },
          },
        },
      },
    },
  });
  if (!payment) throw notFound('Payment not found');
  return payment;
}

/**
 * The udhaar report — who owes what, and for how long.
 *
 * Without a `partyId` this is the whole receivables book grouped by customer.
 * With one, it is that customer's open bills.
 */
export async function getOutstanding(businessId: string, filter: OutstandingFilter = {}) {
  const asOf = filter.asOf ?? new Date();

  const invoices = await prisma.salesInvoice.findMany({
    where: {
      businessId,
      status: 'ISSUED',
      grandTotal: { gt: prisma.salesInvoice.fields.amountPaid },
      ...(filter.partyId ? { partyId: filter.partyId } : {}),
      invoiceDate: { lte: asOf },
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      partyId: true,
      partyName: true,
      grandTotal: true,
      amountPaid: true,
    },
    orderBy: [{ partyName: 'asc' }, { invoiceDate: 'asc' }],
  });

  const withDue = invoices.map((i) => ({
    ...i,
    amountDue: D(i.grandTotal).minus(D(i.amountPaid)),
    daysOutstanding: Math.floor(
      (asOf.getTime() - (i.dueDate ?? i.invoiceDate).getTime()) / (24 * 60 * 60 * 1000),
    ),
  }));

  // Per-party rollup.
  const byParty = new Map<string, { partyId: string; partyName: string; invoices: typeof withDue }>();
  for (const invoice of withDue) {
    const entry = byParty.get(invoice.partyId);
    if (entry) entry.invoices.push(invoice);
    else byParty.set(invoice.partyId, { partyId: invoice.partyId, partyName: invoice.partyName, invoices: [invoice] });
  }

  const minBalance = filter.minBalance ? D(filter.minBalance) : ZERO();

  const parties = [...byParty.values()]
    .map((entry) => ({
      partyId: entry.partyId,
      partyName: entry.partyName,
      invoiceCount: entry.invoices.length,
      ageing: summariseAgeing(entry.invoices, asOf),
      oldestInvoiceDate: entry.invoices[0]!.invoiceDate,
      invoices: filter.partyId ? entry.invoices : undefined,
    }))
    .filter((p) => p.ageing.total.greaterThanOrEqualTo(minBalance))
    .sort((a, b) => b.ageing.total.comparedTo(a.ageing.total));

  return {
    asOf,
    parties,
    grandTotal: summariseAgeing(withDue, asOf),
  };
}
