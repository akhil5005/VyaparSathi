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
import { createTestParty, setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { createPurchase } from '../purchases/purchase.service.js';
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

/**
 * Paying a supplier — the other direction.
 *
 * The service has always handled `PAYMENT`, but nothing exercised it, so the
 * whole mirror image was unproven: that money out settles *purchase* bills and
 * never touches sales ones, that the balance moves the opposite way, and that
 * the voucher lands in its own series rather than sharing the receipt book.
 */
describe('supplier payments (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** Three supplier bills, oldest first, of 1120 / 2240 / 3360. */
  async function threeBills(partyId = scenario.supplier.id) {
    const { ctx, product } = scenario;
    const made = [];
    for (const [index, qty] of [5, 10, 15].entries()) {
      const { purchase } = await createPurchase(
        ctx.businessId,
        ctx.userId,
        {
          partyId,
          supplierInvoiceNumber: `AV/26-27/${index + 1}`,
          supplierInvoiceDate: new Date(Date.UTC(2026, 0, index + 1)),
          items: [{ productId: product.id, quantity: qty, unitId: ctx.unitIds.ream, rate: 200 }],
        },
        ctxOf(),
      );
      made.push(purchase);
    }
    return made;
  }

  it('settles the oldest supplier bill first and moves the balance back toward zero', async () => {
    const { ctx, supplier } = scenario;
    const [first, second] = await threeBills();

    // Three bills totalling 6720 means the balance sits at -6720: we owe them.
    const before = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(before!.currentBalance.toString(), '-6720');

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: supplier.id, direction: 'PAYMENT', amount: 2000, mode: 'BANK_TRANSFER' },
      ctxOf(),
    );

    assert.equal(result.allocatedTo.length, 2);
    assert.equal(result.unallocated.toString(), '0');

    const reloadedFirst = await prisma.purchaseInvoice.findUnique({ where: { id: first!.id } });
    const reloadedSecond = await prisma.purchaseInvoice.findUnique({ where: { id: second!.id } });
    assert.equal(reloadedFirst!.amountPaid.toString(), '1120'); // closed
    assert.equal(reloadedSecond!.amountPaid.toString(), '880'); // partly paid

    // Paying reduces what we owe, so the balance rises toward zero.
    const after = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(after!.currentBalance.toString(), '-4720');

    // Money out is a debit against the supplier's account, the mirror of the
    // credit a receipt writes.
    const entry = await prisma.ledgerEntry.findFirst({ where: { voucherId: result.payment.id } });
    assert.equal(entry!.debit.toString(), '2000');
    assert.equal(entry!.credit.toString(), '0');
    assert.equal(entry!.voucherType, 'PAYMENT');
    assert.match(entry!.narration ?? '', /^Paid to /);
  });

  it('numbers a supplier payment in its own voucher series, not the receipt book', async () => {
    const { ctx, customer, supplier } = scenario;
    await threeBills();

    // A receipt first, so a shared counter would show up as PAY/0002.
    await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, direction: 'RECEIPT', amount: 100, mode: 'CASH' },
      ctxOf(),
    );

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: supplier.id, direction: 'PAYMENT', amount: 500, mode: 'CASH' },
      ctxOf(),
    );

    assert.equal(result.payment.voucherNumber, 'PAY/0001');
  });

  it('keeps money paid beyond the bills on account with the supplier', async () => {
    const { ctx, supplier } = scenario;
    await threeBills();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: supplier.id, direction: 'PAYMENT', amount: 10_000, mode: 'NEFT_RTGS' },
      ctxOf(),
    );

    assert.equal(result.unallocated.toString(), '3280'); // 10000 - 6720

    // Overpaying a supplier leaves them owing us — an advance against the next
    // bill, which is a positive balance under the "positive = they owe us" rule.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '3280');
  });

  it('leaves a sales invoice alone when the same party is paid as a supplier', async () => {
    const { ctx, product } = scenario;

    // A firm you both buy from and sell to — common in this trade, and the one
    // case where picking the wrong invoice table would go unnoticed.
    const both = await createTestParty(ctx, {
      displayName: 'Verma Traders',
      partyType: 'BOTH',
    });

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: both.id, items: [{ productId: product.id, quantity: 4, rate: 250 }] },
      ctxOf(),
    );
    const [bill] = await threeBills(both.id);

    await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: both.id, direction: 'PAYMENT', amount: 1120, mode: 'CASH' },
      ctxOf(),
    );

    // The purchase bill closed; the sales invoice must be untouched.
    const reloadedBill = await prisma.purchaseInvoice.findUnique({ where: { id: bill!.id } });
    assert.equal(reloadedBill!.amountPaid.toString(), '1120');

    const reloadedInvoice = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    assert.equal(reloadedInvoice!.amountPaid.toString(), '0');

    const allocation = await prisma.paymentAllocation.findFirst({
      where: { purchaseInvoiceId: bill!.id },
    });
    assert.ok(allocation, 'the allocation points at the purchase invoice');
    assert.equal(allocation!.salesInvoiceId, null);
  });

  it('reversing a supplier payment reopens the bill and restores what is owed', async () => {
    const { ctx, supplier } = scenario;
    const [first] = await threeBills();

    const result = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: supplier.id, direction: 'PAYMENT', amount: 2000, mode: 'CASH' },
      ctxOf(),
    );

    await reversePayment(ctx.businessId, ctx.userId, result.payment.id, 'Paid the wrong mill', ctxOf());

    const reloaded = await prisma.purchaseInvoice.findUnique({ where: { id: first!.id } });
    assert.equal(reloaded!.amountPaid.toString(), '0');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '-6720');

    const payment = await prisma.payment.findUnique({ where: { id: result.payment.id } });
    assert.ok(payment!.reversedAt);
    assert.equal(await prisma.paymentAllocation.count(), 0);
  });

  it('applies money left on account to a supplier bill entered later', async () => {
    const { ctx, supplier, product } = scenario;

    // Paid an advance to hold stock; the bill arrives with the lorry.
    const advance = await recordPayment(
      ctx.businessId,
      ctx.userId,
      { partyId: supplier.id, direction: 'PAYMENT', amount: 5000, mode: 'BANK_TRANSFER' },
      ctxOf(),
    );
    assert.equal(advance.unallocated.toString(), '5000');

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'AV/26-27/900',
        supplierInvoiceDate: new Date(Date.UTC(2026, 1, 1)),
        items: [{ productId: product.id, quantity: 5, unitId: ctx.unitIds.ream, rate: 200 }],
      },
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

    // Allocation only moves money between buckets — the balance must not shift
    // a second time.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '3880');
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
