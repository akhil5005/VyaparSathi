import { Prisma } from '@prisma/client';
import { D, round2, ZERO } from '../../lib/money.js';

/**
 * Pure allocation and ageing arithmetic — no database, no Express.
 *
 * This is the logic that answers "which bills did that cheque actually pay?".
 * Getting it wrong doesn't throw; it just quietly leaves the wrong invoices
 * showing as unpaid, which is exactly the kind of bug you find six months later
 * during a reconciliation. Hence: pure functions, exhaustively tested.
 */

export interface AllocatableInvoice {
  id: string;
  /// Sort key. Oldest first is the default settlement order in this trade.
  invoiceDate: Date;
  amountDue: Prisma.Decimal;
}

export interface Allocation {
  invoiceId: string;
  amount: Prisma.Decimal;
}

export interface AllocationResult {
  allocations: Allocation[];
  /// Money left over after every open bill is settled. Sits on account as an
  /// advance until the next invoice — it is not an error.
  unallocated: Prisma.Decimal;
}

/**
 * Settles the oldest bills first.
 *
 * This is what a shopkeeper means by "adjust it against the old ones": money
 * received goes to the earliest open invoice until it is closed, then the next.
 * A partial payment leaves the last touched invoice partly paid rather than
 * being spread thinly across everything.
 */
export function allocateFifo(
  amount: Prisma.Decimal.Value,
  invoices: AllocatableInvoice[],
): AllocationResult {
  let remaining = round2(amount);
  const allocations: Allocation[] = [];

  const ordered = [...invoices].sort((a, b) => a.invoiceDate.getTime() - b.invoiceDate.getTime());

  for (const invoice of ordered) {
    if (remaining.lessThanOrEqualTo(0)) break;

    const due = round2(invoice.amountDue);
    if (due.lessThanOrEqualTo(0)) continue;

    const applied = due.lessThan(remaining) ? due : remaining;
    allocations.push({ invoiceId: invoice.id, amount: round2(applied) });
    remaining = round2(remaining.minus(applied));
  }

  return { allocations, unallocated: remaining };
}

export interface ExplicitAllocationRequest {
  invoiceId: string;
  amount: Prisma.Decimal.Value;
}

export interface ValidationIssue {
  invoiceId: string;
  message: string;
}

/**
 * Checks a hand-picked allocation before anything is written.
 *
 * Two failure modes matter: allocating more than the payment is worth, and
 * allocating more to a bill than is still owed on it. Both produce a negative
 * balance somewhere that is painful to unpick afterwards.
 */
export function validateExplicitAllocations(
  paymentAmount: Prisma.Decimal.Value,
  requests: ExplicitAllocationRequest[],
  invoices: AllocatableInvoice[],
): { allocations: Allocation[]; unallocated: Prisma.Decimal; issues: ValidationIssue[] } {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const issues: ValidationIssue[] = [];
  const allocations: Allocation[] = [];
  let total = ZERO();

  const seen = new Set<string>();

  for (const request of requests) {
    const amount = round2(request.amount);

    if (seen.has(request.invoiceId)) {
      issues.push({ invoiceId: request.invoiceId, message: 'Invoice appears more than once' });
      continue;
    }
    seen.add(request.invoiceId);

    if (amount.lessThanOrEqualTo(0)) {
      issues.push({ invoiceId: request.invoiceId, message: 'Allocation must be greater than zero' });
      continue;
    }

    const invoice = byId.get(request.invoiceId);
    if (!invoice) {
      issues.push({
        invoiceId: request.invoiceId,
        message: 'Invoice is not an open bill for this party',
      });
      continue;
    }

    const due = round2(invoice.amountDue);
    if (amount.greaterThan(due)) {
      issues.push({
        invoiceId: request.invoiceId,
        message: `Only ₹${due.toString()} is outstanding on this invoice`,
      });
      continue;
    }

    allocations.push({ invoiceId: request.invoiceId, amount });
    total = total.plus(amount);
  }

  const paid = round2(paymentAmount);
  if (total.greaterThan(paid)) {
    issues.push({
      invoiceId: '',
      message: `Allocations total ₹${total.toString()} but the payment is only ₹${paid.toString()}`,
    });
  }

  return { allocations, unallocated: round2(paid.minus(total)), issues };
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

export const AGEING_BUCKETS = ['current', 'days31to60', 'days61to90', 'over90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export interface AgeableInvoice {
  invoiceDate: Date;
  /// Credit terms move the clock. Without a due date the invoice date is used.
  dueDate?: Date | null;
  amountDue: Prisma.Decimal;
}

export function bucketFor(daysOverdue: number): AgeingBucket {
  if (daysOverdue <= 30) return 'current';
  if (daysOverdue <= 60) return 'days31to60';
  if (daysOverdue <= 90) return 'days61to90';
  return 'over90';
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export type AgeingSummary = Record<AgeingBucket, Prisma.Decimal> & { total: Prisma.Decimal };

/**
 * Buckets outstanding money by how long it has been owed — the report that
 * answers "who has been sitting on my money the longest?".
 */
export function summariseAgeing(invoices: AgeableInvoice[], asOf = new Date()): AgeingSummary {
  const summary = {
    current: ZERO(),
    days31to60: ZERO(),
    days61to90: ZERO(),
    over90: ZERO(),
    total: ZERO(),
  } as AgeingSummary;

  for (const invoice of invoices) {
    const due = round2(invoice.amountDue);
    if (due.lessThanOrEqualTo(0)) continue;

    const reference = invoice.dueDate ?? invoice.invoiceDate;
    const bucket = bucketFor(daysBetween(reference, asOf));

    summary[bucket] = summary[bucket].plus(due);
    summary.total = summary.total.plus(due);
  }

  return summary;
}

/// Total of a list of allocations — used to derive the on-account remainder.
export const totalAllocated = (allocations: Allocation[]): Prisma.Decimal =>
  round2(allocations.reduce<Prisma.Decimal>((acc, a) => acc.plus(D(a.amount)), ZERO()));
