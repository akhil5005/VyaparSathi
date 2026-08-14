/**
 * The party ledger, read across pages.
 *
 * `runningBalance` is computed and stored when a row is written, so it is only
 * truthful read back in insertion order. The ledger used to be served in
 * `entryDate` order, which is the natural instinct for an account and quietly
 * wrong: an invoice carries a time, a payment entered from a date input is
 * midnight, so on a day with both the payment sorts ahead of the sale that
 * caused it and the balance column stops adding up.
 *
 * The parties screen papered over it by re-sorting each page. That could never
 * work across pages, so once the ledger paginated the ordering had to be fixed
 * where it belongs. This proves both halves: the order, and that paging through
 * it does not skip, repeat or reorder a single entry.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { recordPayment } from '../payments/payment.service.js';
import { getPartyLedger } from './party.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('party ledger paging (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** Bills, then takes cash the same day — the shape that broke the ordering. */
  async function tradeOnOneDay(times: number) {
    const { ctx, customer, product } = scenario;
    const sameDay = new Date(Date.UTC(2026, 5, 10, 11, 30));

    for (let i = 0; i < times; i++) {
      await createSalesInvoice(
        ctx.businessId,
        ctx.userId,
        {
          partyId: customer.id,
          invoiceDate: sameDay,
          items: [{ productId: product.id, quantity: 1, rate: 100 }],
        },
        ctxOf(),
      );

      await recordPayment(
        ctx.businessId,
        ctx.userId,
        {
          partyId: customer.id,
          direction: 'RECEIPT',
          amount: '50',
          mode: 'CASH',
          // Midnight, exactly as a date input produces — this is what used to
          // sort ahead of the sale it settles.
          paymentDate: new Date(Date.UTC(2026, 5, 10)),
        },
        ctxOf(),
      );
    }
  }

  it('reads newest first, with every balance following from the row below', async () => {
    await tradeOnOneDay(4);
    const { ctx, customer } = scenario;

    const { entries } = await getPartyLedger(ctx.businessId, customer.id, { pageSize: 50 });
    assert.equal(entries.length, 8);

    for (let i = 0; i < entries.length - 1; i++) {
      const row = entries[i]!;
      const below = entries[i + 1]!;

      // Newest first.
      assert.ok(
        row.createdAt >= below.createdAt,
        `row ${i} was written before the row beneath it`,
      );

      // And the arithmetic the column claims actually holds.
      const expected = below.runningBalance.plus(row.debit).minus(row.credit);
      assert.equal(
        row.runningBalance.toString(),
        expected.toString(),
        `balance at row ${i} does not follow from the one below`,
      );
    }
  });

  it('pages without skipping, repeating or reordering an entry', async () => {
    await tradeOnOneDay(6);
    const { ctx, customer } = scenario;

    const all = await getPartyLedger(ctx.businessId, customer.id, { pageSize: 50 });
    assert.equal(all.total, 12);

    const pageSize = 5;
    const walked: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const chunk = await getPartyLedger(ctx.businessId, customer.id, { page, pageSize });
      assert.equal(chunk.total, 12);
      assert.equal(chunk.page, page);
      walked.push(...chunk.entries.map((e) => e.id));
    }

    assert.deepEqual(
      walked,
      all.entries.map((e) => e.id),
      'walking the pages must reproduce the single-page order exactly',
    );
    assert.equal(new Set(walked).size, 12, 'an entry appeared on two pages');
  });

  it('keeps the balance coherent across the page boundary', async () => {
    await tradeOnOneDay(5);
    const { ctx, customer } = scenario;

    const first = await getPartyLedger(ctx.businessId, customer.id, { page: 1, pageSize: 4 });
    const second = await getPartyLedger(ctx.businessId, customer.id, { page: 2, pageSize: 4 });

    const lastOfFirst = first.entries.at(-1)!;
    const firstOfSecond = second.entries[0]!;

    // The seam is where the old client-side workaround gave up entirely.
    const expected = firstOfSecond.runningBalance
      .plus(lastOfFirst.debit)
      .minus(lastOfFirst.credit);
    assert.equal(lastOfFirst.runningBalance.toString(), expected.toString());
  });

  it('still filters by the date on the document, not when it was typed', async () => {
    const { ctx, customer, product } = scenario;

    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        invoiceDate: new Date(Date.UTC(2026, 2, 15)),
        items: [{ productId: product.id, quantity: 1, rate: 100 }],
      },
      ctxOf(),
    );
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        invoiceDate: new Date(Date.UTC(2026, 5, 15)),
        items: [{ productId: product.id, quantity: 1, rate: 100 }],
      },
      ctxOf(),
    );

    // Both were written seconds apart today; only one belongs to March.
    const march = await getPartyLedger(ctx.businessId, customer.id, {
      fromDate: new Date(Date.UTC(2026, 2, 1)),
      toDate: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
    });

    assert.equal(march.total, 1);
    assert.equal(march.entries[0]!.entryDate.toISOString().slice(0, 10), '2026-03-15');
  });
});
