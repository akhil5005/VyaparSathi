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
import { createTestParty, setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { createPurchase } from '../purchases/purchase.service.js';
import { recordPayment } from '../payments/payment.service.js';
import { getParty, getPartyLedger } from './party.service.js';

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

/**
 * One account per firm, whichever way the trade runs.
 *
 * A paper merchant buys reels from a mill and sells it cut stock; the same name
 * appears on both sides of the book. The ledger has always been keyed on the
 * party rather than the role, but nothing proved that the two directions net
 * off correctly on one page, or that a statement for a period starts from what
 * the previous period left behind.
 */
describe('party ledger for a firm that both buys and sells (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;
  let both: Awaited<ReturnType<typeof createTestParty>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
    both = await createTestParty(scenario.ctx, {
      displayName: 'Verma Traders',
      partyType: 'BOTH',
    });
  });

  after(async () => {
    await disconnect();
  });

  /** Sells them 4 reams (₹1,120 Dr), buys 5 reams back (₹1,120 Cr). */
  async function tradeBothWays() {
    const { ctx, product } = scenario;

    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: both.id,
        invoiceDate: new Date(Date.UTC(2026, 4, 10)),
        items: [{ productId: product.id, quantity: 4, rate: 250 }],
      },
      ctxOf(),
    );

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: both.id,
        supplierInvoiceNumber: 'VT/26-27/7',
        supplierInvoiceDate: new Date(Date.UTC(2026, 4, 20)),
        items: [{ productId: product.id, quantity: 5, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );
  }

  it('puts a sale and a purchase to the same firm on one account, netting off', async () => {
    const { ctx } = scenario;
    await tradeBothWays();

    const ledger = await getPartyLedger(ctx.businessId, both.id, { pageSize: 50 });

    assert.equal(ledger.total, 2, 'both documents land on one ledger');
    assert.equal(ledger.party.partyType, 'BOTH');

    // A sale debits them, a purchase credits them. Equal and opposite here.
    assert.equal(ledger.totalDebit.toString(), '1120');
    assert.equal(ledger.totalCredit.toString(), '1120');
    assert.equal(ledger.closingBalance.toString(), '0');

    // And the cached balance agrees with the ledger it summarises.
    const cached = await prisma.partyBalance.findUnique({ where: { partyId: both.id } });
    assert.equal(cached!.currentBalance.toString(), '0');
  });

  it('carries the earlier balance into a date-filtered statement', async () => {
    const { ctx, product } = scenario;

    // Last year: a sale that is never paid, so ₹1,120 is carried forward.
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: both.id,
        invoiceDate: new Date(Date.UTC(2026, 0, 15)),
        items: [{ productId: product.id, quantity: 4, rate: 250 }],
      },
      ctxOf(),
    );

    await tradeBothWays();

    // Statement for the year beginning 1 April 2026.
    const statement = await getPartyLedger(ctx.businessId, both.id, {
      fromDate: new Date(Date.UTC(2026, 3, 1)),
      pageSize: 50,
    });

    assert.equal(statement.total, 2, 'January is outside the period');
    // The whole point: the period opens where the last one closed.
    assert.equal(statement.openingBalance.toString(), '1120');
    assert.equal(statement.totalDebit.toString(), '1120');
    assert.equal(statement.totalCredit.toString(), '1120');
    assert.equal(
      statement.closingBalance.toString(),
      '1120',
      'closing must include what was brought forward, not just the period movement',
    );
  });

  it('reports no opening balance when the whole account is asked for', async () => {
    const { ctx } = scenario;
    await tradeBothWays();

    const all = await getPartyLedger(ctx.businessId, both.id, { pageSize: 50 });
    // Without a fromDate the period is the entire account, and its own first
    // entry is the opening one — counting anything else would double it.
    assert.equal(all.openingBalance.toString(), '0');
    assert.equal(all.closingBalance.toString(), '0');
  });

  it('reads oldest first when asked to, with balances building downward', async () => {
    const { ctx } = scenario;
    await tradeBothWays();

    const asc = await getPartyLedger(ctx.businessId, both.id, { order: 'asc', pageSize: 50 });
    assert.equal(asc.order, 'asc');

    const [first, second] = asc.entries;
    assert.ok(first!.createdAt <= second!.createdAt, 'ascending means oldest first');
    assert.equal(first!.debit.toString(), '1120', 'the sale comes first');
    assert.equal(second!.credit.toString(), '1120', 'then the purchase');

    // Each row follows from the one above, which is how a printed ledger reads.
    const expected = first!.runningBalance.plus(second!.debit).minus(second!.credit);
    assert.equal(second!.runningBalance.toString(), expected.toString());
  });

  it('counts both sides of the relationship on the party record', async () => {
    const { ctx } = scenario;
    await tradeBothWays();

    const party = await getParty(ctx.businessId, both.id);

    assert.equal(party.stats.invoiceCount, 1);
    assert.equal(party.stats.totalBilled.toString(), '1120');
    // Previously absent entirely, so a pure supplier read "₹0.00, 0 invoices"
    // however much had moved through the account.
    assert.equal(party.stats.purchaseCount, 1);
    assert.equal(party.stats.totalPurchased.toString(), '1120');
  });

  /**
   * The shape of the first real supplier account on the live shop.
   *
   * AV Enterprises billed on 14 August 2026 and was paid in full on the 16th,
   * and this pins what the Ledger screen must show for the financial year
   * containing both: nothing brought forward, a purchase that leaves us owing,
   * a payment that clears it, nil at the close. The dates and the sequence are
   * the real case; the amounts are the fixture's, which taxes at 12% rather
   * than the 18% the shop actually charges.
   */
  it('shows a real supplier bill and its payment netting to nil over the year', async () => {
    const { ctx, product } = scenario;

    const supplier = await createTestParty(ctx, {
      displayName: 'AV Enterprises',
      partyType: 'SUPPLIER',
    });

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'AV/26-27/549',
        supplierInvoiceDate: new Date(Date.UTC(2026, 7, 14)),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    await recordPayment(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        direction: 'PAYMENT',
        amount: 22400,
        mode: 'BANK_TRANSFER',
        paymentDate: new Date(Date.UTC(2026, 7, 16)),
      },
      ctxOf(),
    );

    // Exactly what the FY 2026-27 preset asks for.
    const fy = await getPartyLedger(ctx.businessId, supplier.id, {
      fromDate: new Date(Date.UTC(2026, 3, 1)),
      toDate: new Date(Date.UTC(2027, 2, 31, 23, 59, 59, 999)),
      order: 'asc',
      pageSize: 50,
    });

    assert.equal(fy.openingBalance.toString(), '0', 'nothing precedes the year');
    assert.equal(fy.total, 2);

    const [purchase, payment] = fy.entries;
    assert.equal(purchase!.voucherType, 'PURCHASE_INVOICE');
    assert.equal(purchase!.credit.toString(), '22400');
    assert.equal(purchase!.runningBalance.toString(), '-22400', 'a purchase leaves us owing them');

    assert.equal(payment!.voucherType, 'PAYMENT');
    assert.equal(payment!.debit.toString(), '22400');
    assert.equal(payment!.runningBalance.toString(), '0');

    assert.equal(fy.closingBalance.toString(), '0', 'settled by the end of the year');

    // The closing day of the financial year must be inside the window — a date
    // input sends midnight, which used to drop every entry made on 31 March.
    const lastDay = await getPartyLedger(ctx.businessId, supplier.id, {
      fromDate: new Date(Date.UTC(2026, 7, 16)),
      toDate: new Date(Date.UTC(2026, 7, 16, 23, 59, 59, 999)),
      pageSize: 50,
    });
    assert.equal(lastDay.total, 1, 'the payment falls on the closing day of the range');
    assert.equal(lastDay.openingBalance.toString(), '-22400', 'brought forward from the 14th');
    assert.equal(lastDay.closingBalance.toString(), '0');
  });

  it('keeps another firm’s entries out of this account', async () => {
    const { ctx, customer, product } = scenario;
    await tradeBothWays();

    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        invoiceDate: new Date(Date.UTC(2026, 4, 11)),
        items: [{ productId: product.id, quantity: 9, rate: 250 }],
      },
      ctxOf(),
    );

    const ledger = await getPartyLedger(ctx.businessId, both.id, { pageSize: 50 });
    assert.equal(ledger.total, 2, 'the other customer’s bill must not appear here');
    assert.equal(ledger.totalDebit.toString(), '1120');
  });
});
