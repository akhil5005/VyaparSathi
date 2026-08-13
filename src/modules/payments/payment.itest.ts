/**
 * Payments against a real Postgres.
 *
 * The allocation unit tests prove the FIFO arithmetic. This file proves the
 * bit that only a database can show: that the party-balance row lock stops two
 * concurrent receipts from allocating the same invoice twice.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import {
  allocateExistingPayment,
  getOutstanding,
  recordPayment,
  removeAllocation,
  reversePayment,
} from './payment.service.js';
import { bounceCheque, clearCheque, depositCheque, listCheques } from './cheque.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('payments (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** Three invoices, oldest first, of 1120 / 2240 / 3360. */
  async function threeInvoices() {
    const { ctx, customer, product } = scenario;
    const made = [];
    for (const [index, qty] of [4, 8, 12].entries()) {
      const { invoice } = await createSalesInvoice(
        ctx.businessId,
        ctx.userId,
        {
          partyId: customer.id,
          invoiceDate: new Date(Date.UTC(2026, 0, index + 1)),
          items: [{ productId: product.id, quantity: qty, rate: 250 }],
        },
        ctxOf(),
      );
      made.push(invoice);
    }
    return made;
  }

  it('settles the oldest bill first and reduces the balance', async () => {
    const { ctx, customer } = scenario;
    const [first, second] = await threeInvoices();

    // 1120 + 2240 + 3360 = 6720 owed. Pay 2000.
    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 2000, mode: 'CASH' },
      ctxOf(),
    );

    assert.equal(result.payment.voucherNumber, 'RCP/0001');
    assert.equal(result.allocatedTo.length, 2);
    assert.equal(result.unallocated.toString(), '0');

    const reloadedFirst = await prisma.salesInvoice.findUnique({ where: { id: first!.id } });
    const reloadedSecond = await prisma.salesInvoice.findUnique({ where: { id: second!.id } });
    assert.equal(reloadedFirst!.amountPaid.toString(), '1120'); // closed
    assert.equal(reloadedSecond!.amountPaid.toString(), '880'); // partly paid

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '4720'); // 6720 - 2000

    const entry = await prisma.ledgerEntry.findFirst({
      where: { voucherId: result.payment.id },
    });
    assert.equal(entry!.credit.toString(), '2000');
  });

  it('keeps an overpayment on account', async () => {
    const { ctx, customer } = scenario;
    await threeInvoices();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 10_000, mode: 'UPI' },
      ctxOf(),
    );

    assert.equal(result.unallocated.toString(), '3280'); // 10000 - 6720

    // An advance makes the balance negative — we owe them goods.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '-3280');
  });

  it('applies on-account money to a bill raised later', async () => {
    const { ctx, customer, product } = scenario;

    // Advance arrives before any bill.
    const advance = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 5000, mode: 'BANK_TRANSFER' },
      ctxOf(),
    );
    assert.equal(advance.unallocated.toString(), '5000');

    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 4, rate: 250 }] },
      ctxOf(),
    );

    const applied = await allocateExistingPayment(
      ctx.businessId,
      ctx.userId,
      advance.payment.id,
      { auto: true },
      ctxOf(),
    );

    assert.equal(applied.applied.toString(), '1120');
    assert.equal(applied.payment.unallocatedAmount.toString(), '3880');

    // Allocation moves money between buckets inside the account — the balance
    // itself must not move again.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '-3880');
  });

  it('honours a hand-picked allocation', async () => {
    const { ctx, customer } = scenario;
    const [first, , third] = await threeInvoices();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        direction: 'RECEIPT',
        amount: 3360,
        mode: 'CASH',
        // Deliberately skip the two older bills.
        allocations: [{ invoiceId: third!.id, amount: 3360 }],
      },
      ctxOf(),
    );

    assert.equal(result.allocatedTo.length, 1);

    const reloadedFirst = await prisma.salesInvoice.findUnique({ where: { id: first!.id } });
    assert.equal(reloadedFirst!.amountPaid.toString(), '0');

    const reloadedThird = await prisma.salesInvoice.findUnique({ where: { id: third!.id } });
    assert.equal(reloadedThird!.amountPaid.toString(), '3360');
  });

  it('rejects allocating more to a bill than it owes, writing nothing', async () => {
    const { ctx, customer } = scenario;
    const [first] = await threeInvoices();

    await assert.rejects(
      recordPayment(
        ctx.businessId,
        ctx.userId,
        {
          partyId: customer.id,
          direction: 'RECEIPT',
          amount: 5000,
          mode: 'CASH',
          allocations: [{ invoiceId: first!.id, amount: 5000 }],
        },
        ctxOf(),
      ),
      /could not be applied/,
    );

    assert.equal(await prisma.payment.count(), 0);
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '6720'); // untouched
  });

  it('does not over-allocate when receipts land concurrently', async () => {
    const { ctx, customer } = scenario;
    const invoices = await threeInvoices();
    const totalOwed = 6720;

    // Six simultaneous receipts of 1000. Without the party-balance row lock,
    // several would read the same open bills and allocate against them twice.
    await Promise.all(
      Array.from({ length: 6 }, () =>
        recordPayment(
          ctx.businessId,
          ctx.userId,
          { partyId: customer.id, direction: 'RECEIPT', amount: 1000, mode: 'CASH' },
          ctxOf(),
        ),
      ),
    );

    const reloaded = await prisma.salesInvoice.findMany({
      where: { id: { in: invoices.map((i) => i.id) } },
    });

    for (const invoice of reloaded) {
      assert.ok(
        Number(invoice.amountPaid) <= Number(invoice.grandTotal),
        `invoice ${invoice.invoiceNumber} over-allocated: paid ${invoice.amountPaid} of ${invoice.grandTotal}`,
      );
    }

    const allocatedTotal = await prisma.paymentAllocation.aggregate({ _sum: { amount: true } });
    assert.equal(Number(allocatedTotal._sum.amount), 6000);

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), String(totalOwed - 6000));
  });

  it('unallocating returns the money to the on-account pool', async () => {
    const { ctx, customer } = scenario;
    const [first] = await threeInvoices();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 1120, mode: 'CASH' },
      ctxOf(),
    );

    const allocation = await prisma.paymentAllocation.findFirst({
      where: { paymentId: result.payment.id },
    });
    await removeAllocation(ctx.businessId, ctx.userId, result.payment.id, allocation!.id, ctxOf());

    const reloadedInvoice = await prisma.salesInvoice.findUnique({ where: { id: first!.id } });
    assert.equal(reloadedInvoice!.amountPaid.toString(), '0');

    const reloadedPayment = await prisma.payment.findUnique({ where: { id: result.payment.id } });
    assert.equal(reloadedPayment!.unallocatedAmount.toString(), '1120');
  });

  it('reversing reopens the bills and restores the balance without deleting anything', async () => {
    const { ctx, customer } = scenario;
    const [first] = await threeInvoices();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 2000, mode: 'CASH' },
      ctxOf(),
    );

    await reversePayment(ctx.businessId, ctx.userId, result.payment.id, 'Entered twice', ctxOf());

    const reloadedInvoice = await prisma.salesInvoice.findUnique({ where: { id: first!.id } });
    assert.equal(reloadedInvoice!.amountPaid.toString(), '0');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '6720');

    // The payment row survives — a payment that vanishes is what the audit
    // trail exists to prevent.
    const payment = await prisma.payment.findUnique({ where: { id: result.payment.id } });
    assert.ok(payment);
    assert.ok(payment!.reversedAt);
    assert.equal(await prisma.paymentAllocation.count(), 0);
  });

  it('refuses to reverse the same payment twice', async () => {
    const { ctx, customer } = scenario;
    await threeInvoices();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 500, mode: 'CASH' },
      ctxOf(),
    );

    await reversePayment(ctx.businessId, ctx.userId, result.payment.id, 'First', ctxOf());
    await assert.rejects(
      reversePayment(ctx.businessId, ctx.userId, result.payment.id, 'Second', ctxOf()),
      /already been reversed/,
    );
  });

  it('reports outstanding money bucketed by age', async () => {
    const { ctx, customer } = scenario;
    await threeInvoices();

    const report = await getOutstanding(ctx.businessId, { asOf: new Date(Date.UTC(2026, 2, 1)) });

    assert.equal(report.parties.length, 1);
    assert.equal(report.parties[0]!.partyName, customer.displayName);
    assert.equal(report.grandTotal.total.toString(), '6720');
    // All three invoices are from early January, so on 1 March they are 59-60
    // days old — the 31-60 bucket.
    assert.equal(report.grandTotal.days31to60.toString(), '6720');
  });
});

describe('cheques (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  async function invoiceAndCheque(chequeDate: Date) {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 250 }] },
      ctxOf(),
    );

    const payment = await recordPayment(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        direction: 'RECEIPT',
        amount: 2800,
        mode: 'CHEQUE',
        cheque: { chequeNumber: '000123', bankName: 'PNB', chequeDate },
      },
      ctxOf(),
    );

    return { invoice, payment };
  }

  it('records a cheque and settles the bill on receipt', async () => {
    const { ctx, customer } = scenario;
    const { invoice } = await invoiceAndCheque(new Date(Date.UTC(2026, 0, 15)));

    const reloaded = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    assert.equal(reloaded!.amountPaid.toString(), '2800');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '0');

    const cheque = await prisma.cheque.findFirst({ where: { businessId: ctx.businessId } });
    assert.equal(cheque!.status, 'PENDING');
  });

  it('clearing confirms the cheque without moving money again', async () => {
    const { ctx, customer } = scenario;
    await invoiceAndCheque(new Date(Date.UTC(2026, 0, 15)));

    const cheque = await prisma.cheque.findFirst({ where: { businessId: ctx.businessId } });
    await depositCheque(ctx.businessId, cheque!.id);
    await clearCheque(ctx.businessId, cheque!.id);

    const reloaded = await prisma.cheque.findUnique({ where: { id: cheque!.id } });
    assert.equal(reloaded!.status, 'CLEARED');

    // The ledger was posted on receipt; clearing must not double-count.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '0');
    assert.equal(await prisma.ledgerEntry.count({ where: { partyId: customer.id } }), 2);
  });

  it('a bounce reopens the bill, restores the balance and adds bank charges', async () => {
    const { ctx, customer } = scenario;
    const { invoice } = await invoiceAndCheque(new Date(Date.UTC(2026, 0, 15)));

    const cheque = await prisma.cheque.findFirst({ where: { businessId: ctx.businessId } });
    await bounceCheque(
      ctx.businessId,
      ctx.userId,
      cheque!.id,
      { reason: 'Insufficient funds', bounceCharges: 250 },
      ctxOf(),
    );

    const reloadedCheque = await prisma.cheque.findUnique({ where: { id: cheque!.id } });
    assert.equal(reloadedCheque!.status, 'BOUNCED');

    const reloadedInvoice = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    assert.equal(reloadedInvoice!.amountPaid.toString(), '0');

    // 2800 re-owed plus 250 of bank charges recovered from the customer.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '3050');
  });

  it('lists only bankable cheques when asked what can go to the bank', async () => {
    const { ctx } = scenario;
    // Post-dated: written for a date in the far future.
    await invoiceAndCheque(new Date(Date.UTC(2099, 0, 1)));

    const dueNow = await listCheques(ctx.businessId, { dueBy: new Date() });
    assert.equal(dueNow.total, 0);

    const all = await listCheques(ctx.businessId, {});
    assert.equal(all.total, 1);
    assert.equal(all.cheques[0]!.bankable, false);
  });

  it('refuses an impossible status transition', async () => {
    const { ctx } = scenario;
    await invoiceAndCheque(new Date(Date.UTC(2026, 0, 15)));

    const cheque = await prisma.cheque.findFirst({ where: { businessId: ctx.businessId } });
    await depositCheque(ctx.businessId, cheque!.id);
    await clearCheque(ctx.businessId, cheque!.id);

    await assert.rejects(
      bounceCheque(ctx.businessId, ctx.userId, cheque!.id, { reason: 'Too late' }, ctxOf()),
      /cannot be marked bounced/,
    );
  });
});
