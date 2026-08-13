/**
 * Allocation decides which bills a payment actually closed. When it is wrong
 * nothing throws — the wrong invoices just sit there looking unpaid, and you
 * find out during a reconciliation months later. Hence the coverage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../lib/money.js';
import {
  allocateFifo,
  bucketFor,
  daysBetween,
  summariseAgeing,
  totalAllocated,
  validateExplicitAllocations,
} from './allocation.js';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const invoice = (id: string, iso: string, due: number | string) => ({
  id,
  invoiceDate: day(iso),
  amountDue: D(due),
});

describe('allocateFifo', () => {
  it('closes the oldest bill first', () => {
    const result = allocateFifo(1000, [
      invoice('new', '2026-03-01', 800),
      invoice('old', '2026-01-01', 600),
    ]);

    assert.equal(result.allocations.length, 2);
    assert.equal(result.allocations[0]!.invoiceId, 'old');
    assert.equal(result.allocations[0]!.amount.toString(), '600');
    assert.equal(result.allocations[1]!.invoiceId, 'new');
    assert.equal(result.allocations[1]!.amount.toString(), '400');
    assert.equal(result.unallocated.toString(), '0');
  });

  it('leaves the last touched bill partly paid rather than spreading thinly', () => {
    const result = allocateFifo(500, [invoice('a', '2026-01-01', 300), invoice('b', '2026-02-01', 900)]);
    assert.equal(result.allocations[0]!.amount.toString(), '300');
    assert.equal(result.allocations[1]!.amount.toString(), '200');
  });

  it('puts the remainder on account when every bill is settled', () => {
    const result = allocateFifo(5000, [invoice('a', '2026-01-01', 1200)]);
    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0]!.amount.toString(), '1200');
    assert.equal(result.unallocated.toString(), '3800');
  });

  it('takes the whole payment on account when there are no open bills', () => {
    const result = allocateFifo(2500, []);
    assert.equal(result.allocations.length, 0);
    assert.equal(result.unallocated.toString(), '2500');
  });

  it('skips invoices with nothing outstanding', () => {
    const result = allocateFifo(500, [
      invoice('paid', '2026-01-01', 0),
      invoice('open', '2026-02-01', 500),
    ]);
    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0]!.invoiceId, 'open');
  });

  it('handles paise without drift', () => {
    const result = allocateFifo('1000.05', [
      invoice('a', '2026-01-01', '333.35'),
      invoice('b', '2026-02-01', '333.35'),
      invoice('c', '2026-03-01', '333.35'),
    ]);
    assert.equal(totalAllocated(result.allocations).toString(), '1000.05');
    assert.equal(result.unallocated.toString(), '0');
  });

  it('never allocates more than the payment', () => {
    const result = allocateFifo(100, [
      invoice('a', '2026-01-01', 5000),
      invoice('b', '2026-02-01', 5000),
    ]);
    assert.equal(totalAllocated(result.allocations).toString(), '100');
  });

  it('never allocates more to a bill than is owed on it', () => {
    const result = allocateFifo(10_000, [
      invoice('a', '2026-01-01', 120),
      invoice('b', '2026-02-01', 340),
    ]);
    assert.equal(result.allocations[0]!.amount.toString(), '120');
    assert.equal(result.allocations[1]!.amount.toString(), '340');
  });

  it('does not mutate the input order', () => {
    const invoices = [invoice('new', '2026-03-01', 100), invoice('old', '2026-01-01', 100)];
    allocateFifo(200, invoices);
    assert.equal(invoices[0]!.id, 'new');
  });
});

describe('validateExplicitAllocations', () => {
  const open = [invoice('a', '2026-01-01', 500), invoice('b', '2026-02-01', 300)];

  it('accepts a valid hand-picked allocation', () => {
    const result = validateExplicitAllocations(800, [
      { invoiceId: 'a', amount: 500 },
      { invoiceId: 'b', amount: 300 },
    ], open);

    assert.equal(result.issues.length, 0);
    assert.equal(result.allocations.length, 2);
    assert.equal(result.unallocated.toString(), '0');
  });

  it('allows a partial allocation and leaves the rest on account', () => {
    const result = validateExplicitAllocations(800, [{ invoiceId: 'b', amount: 300 }], open);
    assert.equal(result.issues.length, 0);
    assert.equal(result.unallocated.toString(), '500');
  });

  it('rejects allocating more than a bill owes', () => {
    const result = validateExplicitAllocations(1000, [{ invoiceId: 'b', amount: 900 }], open);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!.message, /Only ₹300 is outstanding/);
  });

  it('rejects allocations totalling more than the payment', () => {
    const result = validateExplicitAllocations(400, [
      { invoiceId: 'a', amount: 300 },
      { invoiceId: 'b', amount: 300 },
    ], open);
    assert.ok(result.issues.some((i) => /but the payment is only/.test(i.message)));
  });

  it('rejects an invoice that is not an open bill for this party', () => {
    const result = validateExplicitAllocations(100, [{ invoiceId: 'zzz', amount: 100 }], open);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!.message, /not an open bill/);
  });

  it('rejects the same invoice listed twice', () => {
    const result = validateExplicitAllocations(400, [
      { invoiceId: 'a', amount: 200 },
      { invoiceId: 'a', amount: 200 },
    ], open);
    assert.ok(result.issues.some((i) => /more than once/.test(i.message)));
  });

  it('rejects a zero or negative allocation', () => {
    const result = validateExplicitAllocations(100, [{ invoiceId: 'a', amount: 0 }], open);
    assert.equal(result.issues.length, 1);
  });
});

describe('ageing', () => {
  it('buckets by days overdue', () => {
    assert.equal(bucketFor(0), 'current');
    assert.equal(bucketFor(30), 'current');
    assert.equal(bucketFor(31), 'days31to60');
    assert.equal(bucketFor(60), 'days31to60');
    assert.equal(bucketFor(61), 'days61to90');
    assert.equal(bucketFor(90), 'days61to90');
    assert.equal(bucketFor(91), 'over90');
    assert.equal(bucketFor(400), 'over90');
  });

  it('counts whole days between dates', () => {
    assert.equal(daysBetween(day('2026-01-01'), day('2026-01-31')), 30);
  });

  it('summarises a receivables book into buckets', () => {
    const asOf = day('2026-04-01');
    const summary = summariseAgeing(
      [
        { invoiceDate: day('2026-03-20'), amountDue: D(1000) }, // 12 days
        { invoiceDate: day('2026-02-20'), amountDue: D(2000) }, // 40 days
        { invoiceDate: day('2026-01-20'), amountDue: D(3000) }, // 71 days
        { invoiceDate: day('2025-10-01'), amountDue: D(4000) }, // 182 days
      ],
      asOf,
    );

    assert.equal(summary.current.toString(), '1000');
    assert.equal(summary.days31to60.toString(), '2000');
    assert.equal(summary.days61to90.toString(), '3000');
    assert.equal(summary.over90.toString(), '4000');
    assert.equal(summary.total.toString(), '10000');
  });

  it('ages from the due date when credit terms were given', () => {
    const asOf = day('2026-04-01');
    // Invoiced 90 days ago but with 60 days' credit, so only 30 days overdue.
    const summary = summariseAgeing(
      [{ invoiceDate: day('2026-01-01'), dueDate: day('2026-03-02'), amountDue: D(500) }],
      asOf,
    );
    assert.equal(summary.current.toString(), '500');
    assert.equal(summary.over90.toString(), '0');
  });

  it('ignores fully paid invoices', () => {
    const summary = summariseAgeing([{ invoiceDate: day('2026-01-01'), amountDue: D(0) }], day('2026-04-01'));
    assert.equal(summary.total.toString(), '0');
  });

  it('buckets always sum to the total', () => {
    const asOf = day('2026-06-01');
    const summary = summariseAgeing(
      [
        { invoiceDate: day('2026-05-25'), amountDue: D('123.45') },
        { invoiceDate: day('2026-04-10'), amountDue: D('678.90') },
        { invoiceDate: day('2026-01-05'), amountDue: D('999.99') },
      ],
      asOf,
    );
    const sum = summary.current
      .plus(summary.days31to60)
      .plus(summary.days61to90)
      .plus(summary.over90);
    assert.equal(sum.toString(), summary.total.toString());
  });
});
