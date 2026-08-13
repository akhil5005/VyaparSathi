import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { D, round2, ZERO } from '../../lib/money.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { RequestContext } from '../auth/auth.service.js';
import { computeSetOff, headsFrom, periodRange, totalHeads } from './gstSetOff.js';
import { getNoteTaxTotals } from '../notes/creditNote.service.js';
import type { claimItcSchema } from './purchase.schemas.js';

type ClaimItcInput = z.infer<typeof claimItcSchema>;

/// Either a "YYYY-MM" period, or an explicit range. The schema enforces that
/// one of the two forms is present; this is the shape the service consumes.
export interface GstSummaryQuery {
  period?: string;
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Marks input credit as claimed in a return period.
 *
 * This is bookkeeping, not filing — it records what your CA put on the return
 * so the next month's "what haven't I claimed?" list is accurate. Nothing here
 * talks to the GST portal.
 */
export async function claimInputCredit(
  businessId: string,
  userId: string,
  input: ClaimItcInput,
  ctx: RequestContext,
) {
  const { fromDate, toDate } = periodRange(input.period);

  let ids: string[];

  if (input.purchaseIds) {
    const found = await prisma.purchaseInvoice.findMany({
      where: { id: { in: input.purchaseIds }, businessId, status: 'ISSUED' },
      select: { id: true, purchaseNumber: true, itcEligible: true, itcClaimed: true, itcClaimedIn: true },
    });

    const missing = input.purchaseIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) throw notFound(`Unknown or unissued purchase(s): ${missing.join(', ')}`);

    const ineligible = found.filter((f) => !f.itcEligible);
    if (ineligible.length > 0) {
      throw badRequest(
        `These bills are marked ineligible for credit: ${ineligible.map((f) => f.purchaseNumber).join(', ')}`,
      );
    }

    const alreadyClaimed = found.filter((f) => f.itcClaimed);
    if (alreadyClaimed.length > 0) {
      throw conflict(
        `Credit was already claimed on: ${alreadyClaimed
          .map((f) => `${f.purchaseNumber} (${f.itcClaimedIn})`)
          .join(', ')}`,
      );
    }

    ids = found.map((f) => f.id);
  } else if (input.claimAllInPeriod) {
    const found = await prisma.purchaseInvoice.findMany({
      where: {
        businessId,
        status: 'ISSUED',
        itcEligible: true,
        itcClaimed: false,
        supplierInvoiceDate: { gte: fromDate, lte: toDate },
      },
      select: { id: true },
    });
    ids = found.map((f) => f.id);
  } else {
    throw badRequest('Give purchaseIds, or set claimAllInPeriod to true');
  }

  if (ids.length === 0) {
    return { period: input.period, claimedCount: 0, creditClaimed: ZERO() };
  }

  const totals = await prisma.purchaseInvoice.aggregate({
    where: { id: { in: ids } },
    _sum: { totalCgst: true, totalSgst: true, totalIgst: true, totalCess: true },
  });

  await prisma.$transaction([
    prisma.purchaseInvoice.updateMany({
      where: { id: { in: ids } },
      data: { itcClaimed: true, itcClaimedIn: input.period },
    }),
    prisma.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'itc.claim',
        entityType: 'PurchaseInvoice',
        after: { period: input.period, count: ids.length },
        ipAddress: ctx.ipAddress ?? null,
      },
    }),
  ]);

  const heads = headsFrom(
    totals._sum.totalCgst ?? 0,
    totals._sum.totalSgst ?? 0,
    totals._sum.totalIgst ?? 0,
    totals._sum.totalCess ?? 0,
  );

  return { period: input.period, claimedCount: ids.length, creditClaimed: totalHeads(heads), heads };
}

/** Undoes a claim — for when the CA moves a bill to a different return. */
export async function unclaimInputCredit(
  businessId: string,
  userId: string,
  purchaseId: string,
  ctx: RequestContext,
) {
  const purchase = await prisma.purchaseInvoice.findFirst({
    where: { id: purchaseId, businessId },
    select: { id: true, itcClaimed: true, itcClaimedIn: true, purchaseNumber: true },
  });
  if (!purchase) throw notFound('Purchase not found');
  if (!purchase.itcClaimed) throw conflict('No credit has been claimed on this bill');

  await prisma.$transaction([
    prisma.purchaseInvoice.update({
      where: { id: purchaseId },
      data: { itcClaimed: false, itcClaimedIn: null },
    }),
    prisma.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'itc.unclaim',
        entityType: 'PurchaseInvoice',
        entityId: purchaseId,
        before: { itcClaimedIn: purchase.itcClaimedIn },
        ipAddress: ctx.ipAddress ?? null,
      },
    }),
  ]);

  return { unclaimed: true, purchaseNumber: purchase.purchaseNumber };
}

/**
 * The report he actually wants: what do I owe the government this month?
 *
 * Output tax from sales, input credit from purchases, and the set-off between
 * them — which is not a simple subtraction, because CGST credit cannot pay SGST
 * and vice versa.
 */
export async function getGstSummary(businessId: string, query: GstSummaryQuery) {
  const range = query.period
    ? periodRange(query.period)
    : { fromDate: query.fromDate!, toDate: query.toDate! };

  const [sales, purchases, unclaimed] = await Promise.all([
    prisma.salesInvoice.aggregate({
      where: {
        businessId,
        status: 'ISSUED',
        invoiceDate: { gte: range.fromDate, lte: range.toDate },
      },
      _count: true,
      _sum: {
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalCess: true,
        grandTotal: true,
      },
    }),
    prisma.purchaseInvoice.aggregate({
      where: {
        businessId,
        status: 'ISSUED',
        itcEligible: true,
        supplierInvoiceDate: { gte: range.fromDate, lte: range.toDate },
      },
      _count: true,
      _sum: {
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalCess: true,
        grandTotal: true,
      },
    }),
    // Eligible credit from earlier periods that was never claimed — money still
    // on the table, and the most common thing a small business loses.
    prisma.purchaseInvoice.aggregate({
      where: {
        businessId,
        status: 'ISSUED',
        itcEligible: true,
        itcClaimed: false,
        supplierInvoiceDate: { lt: range.fromDate },
      },
      _count: true,
      _sum: { totalCgst: true, totalSgst: true, totalIgst: true, totalCess: true },
    }),
  ]);

  // Notes move both sides: a sales credit note reduces output tax, a sales
  // debit note increases it, and a purchase return reverses input credit.
  // Omitting them overstates the liability in one direction or the other.
  const notes = await getNoteTaxTotals(businessId, range.fromDate, range.toDate);

  const outputTax = headsFrom(
    D(sales._sum.totalCgst ?? 0)
      .minus(notes.salesCreditNotes.cgst)
      .plus(notes.salesDebitNotes.cgst),
    D(sales._sum.totalSgst ?? 0)
      .minus(notes.salesCreditNotes.sgst)
      .plus(notes.salesDebitNotes.sgst),
    D(sales._sum.totalIgst ?? 0)
      .minus(notes.salesCreditNotes.igst)
      .plus(notes.salesDebitNotes.igst),
    D(sales._sum.totalCess ?? 0)
      .minus(notes.salesCreditNotes.cess)
      .plus(notes.salesDebitNotes.cess),
  );

  const inputCredit = headsFrom(
    D(purchases._sum.totalCgst ?? 0).minus(notes.purchaseReturns.cgst),
    D(purchases._sum.totalSgst ?? 0).minus(notes.purchaseReturns.sgst),
    D(purchases._sum.totalIgst ?? 0).minus(notes.purchaseReturns.igst),
    D(purchases._sum.totalCess ?? 0).minus(notes.purchaseReturns.cess),
  );

  const setOff = computeSetOff(outputTax, inputCredit);

  const priorUnclaimed = headsFrom(
    unclaimed._sum.totalCgst ?? 0,
    unclaimed._sum.totalSgst ?? 0,
    unclaimed._sum.totalIgst ?? 0,
    unclaimed._sum.totalCess ?? 0,
  );

  return {
    period: query.period ?? null,
    fromDate: range.fromDate,
    toDate: range.toDate,

    sales: {
      invoiceCount: sales._count,
      taxableValue: D(sales._sum.taxableValue ?? 0),
      grandTotal: D(sales._sum.grandTotal ?? 0),
      tax: outputTax,
      totalTax: totalHeads(outputTax),
    },
    purchases: {
      invoiceCount: purchases._count,
      taxableValue: D(purchases._sum.taxableValue ?? 0),
      grandTotal: D(purchases._sum.grandTotal ?? 0),
      tax: inputCredit,
      totalTax: totalHeads(inputCredit),
    },

    /// Shown separately so the summary reconciles against the raw invoice
    /// totals above — output tax here is already net of these.
    notes,

    setOff,

    priorPeriodUnclaimed: {
      invoiceCount: unclaimed._count,
      heads: priorUnclaimed,
      total: totalHeads(priorUnclaimed),
    },

    /// Rough margin for the period. Sales value less purchase value is not
    /// gross profit — it ignores opening and closing stock — but it is a
    /// useful sanity check month to month.
    indicativeGrossValue: round2(
      D(sales._sum.taxableValue ?? 0).minus(D(purchases._sum.taxableValue ?? 0)),
    ),

    disclaimer:
      'Indicative only. Reversals, blocked credits and provisional-credit rules are not applied — ' +
      'the return filed by your CA is the authority.',
  };
}

/** Bills whose credit is still unclaimed, oldest first. */
export async function getPendingItc(businessId: string, beforeDate?: Date) {
  const rows = await prisma.purchaseInvoice.findMany({
    where: {
      businessId,
      status: 'ISSUED',
      itcEligible: true,
      itcClaimed: false,
      ...(beforeDate ? { supplierInvoiceDate: { lte: beforeDate } } : {}),
    },
    orderBy: { supplierInvoiceDate: 'asc' },
    select: {
      id: true,
      purchaseNumber: true,
      supplierInvoiceNumber: true,
      supplierInvoiceDate: true,
      partyName: true,
      partyGstin: true,
      taxableValue: true,
      totalCgst: true,
      totalSgst: true,
      totalIgst: true,
      totalCess: true,
      grandTotal: true,
    },
  });

  const heads = headsFrom(
    rows.reduce((a, r) => a.plus(D(r.totalCgst)), ZERO()),
    rows.reduce((a, r) => a.plus(D(r.totalSgst)), ZERO()),
    rows.reduce((a, r) => a.plus(D(r.totalIgst)), ZERO()),
    rows.reduce((a, r) => a.plus(D(r.totalCess)), ZERO()),
  );

  return {
    purchases: rows.map((r) => ({
      ...r,
      creditAvailable: round2(D(r.totalCgst).plus(D(r.totalSgst)).plus(D(r.totalIgst))),
    })),
    count: rows.length,
    heads,
    totalCredit: totalHeads(heads),
  };
}
