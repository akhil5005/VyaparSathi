/**
 * Answering a spoken question, against a real database.
 *
 * The model call is not exercised here — the intent is handed in directly,
 * which is the right seam: what needs proving is not that Claude picks
 * PARTY_BALANCE, it is that once it has, the figure spoken back is the figure
 * in the ledger, said the right way round, to somebody allowed to hear it.
 *
 * The last test in this file is the one that matters most. It runs every intent
 * and proves nothing in the database moved.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import {
  createTestParty,
  createTestProduct,
  setupBillingScenario,
} from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { answerIntent, shortlistFor, type Intent, type Shortlist } from './voiceQuery.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

/// A confident intent, so a test only has to say what it is testing.
const asked = (over: Partial<Intent>): Intent => ({
  intent: 'UNKNOWN',
  partyId: null,
  productId: null,
  period: null,
  confidence: 0.95,
  reasoning: 'test',
  ...over,
});

const empty: Shortlist = { parties: [], products: [] };

describe('voice questions (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  // -------------------------------------------------------------------------
  // Getting from words to candidates
  // -------------------------------------------------------------------------

  it('finds the party in a sentence that is mostly other words', async () => {
    const { ctx, customer } = scenario;
    const list = await shortlistFor(ctx.businessId, 'sharma stationery da balance kinna hai');

    assert.equal(list.parties[0]?.id, customer.id);
  });

  it('offers both when two names are a hair apart', async () => {
    const { ctx } = scenario;
    await createTestParty(ctx, { displayName: 'Verma Stationery' });
    await createTestParty(ctx, { displayName: 'Verma Stationers' });

    const list = await shortlistFor(ctx.businessId, 'verma stationary nu kinna dena hai');
    assert.ok(list.parties.length >= 2, 'the choice has to reach the operator');
  });

  it('never reaches into another shop', async () => {
    const { ctx } = scenario;
    const other = await setupBillingScenario();

    const list = await shortlistFor(ctx.businessId, 'sharma stationery da balance');
    assert.ok(list.parties.every((p) => p.id !== other.customer.id));
  });

  // -------------------------------------------------------------------------
  // Balances — the answer that must never be back to front
  // -------------------------------------------------------------------------

  it('says a customer owes you when the balance is positive', async () => {
    const { ctx } = scenario;
    const party = await createTestParty(ctx, { displayName: 'Gupta Books', openingBalance: 12450 });

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_BALANCE', partyId: party.id }),
      empty,
    );

    assert.match(answer.answer, /Gupta Books owes you/);
    assert.match(answer.answer, /12,450\.00/);
  });

  it('says you owe them when the balance is negative, not "owes -12450"', async () => {
    const { ctx } = scenario;
    const party = await createTestParty(ctx, {
      displayName: 'JK Mills',
      partyType: 'SUPPLIER',
      openingBalance: -8000,
    });

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_BALANCE', partyId: party.id }),
      empty,
    );

    // Read aloud at a counter, a minus sign is inaudible. The direction has to
    // be in the words.
    assert.match(answer.answer, /^You owe JK Mills ₹8,000\.00\.$/);
  });

  it('calls a settled account settled rather than reading out a zero', async () => {
    const { ctx, customer } = scenario;
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_BALANCE', partyId: customer.id }),
      empty,
    );

    assert.match(answer.answer, /settled/);
  });

  it('asks which account instead of guessing when the model was unsure', async () => {
    const { ctx, customer } = scenario;
    const list: Shortlist = {
      parties: [{ id: customer.id, displayName: customer.displayName, score: 0.5 }],
      products: [],
    };

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_BALANCE', partyId: customer.id, confidence: 0.35 }),
      list,
    );

    assert.equal(answer.choices?.kind, 'party');
    assert.ok(!/₹/.test(answer.answer), 'an unsure answer must not state a figure');
  });

  it('will not answer for a party belonging to somebody else', async () => {
    const { ctx } = scenario;
    const other = await setupBillingScenario();

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_BALANCE', partyId: other.customer.id }),
      empty,
    );

    assert.match(answer.answer, /no longer on file/);
  });

  // -------------------------------------------------------------------------
  // Stock and rates
  // -------------------------------------------------------------------------

  it('reports stock in the base unit', async () => {
    const { ctx, product } = scenario;
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_STOCK', productId: product.id }),
      empty,
      { canSeeCost: true },
    );

    // 100 reams on hand at 200 average cost.
    assert.match(answer.answer, /100 rm of JK Copier A4 75gsm/);
    assert.ok(answer.details.some((d) => d.value.includes('20,000.00')));
  });

  it('keeps the stock value from someone who may not see cost', async () => {
    const { ctx, product } = scenario;
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_STOCK', productId: product.id }),
      empty,
      { canSeeCost: false },
    );

    assert.match(answer.answer, /100 rm/, 'the quantity is not secret');
    assert.ok(
      answer.details.every((d) => !d.label.includes('cost')),
      'what it cost is',
    );
  });

  it('says plainly when stock has gone negative rather than reading a minus', async () => {
    const { ctx } = scenario;
    const product = await createTestProduct(ctx, { name: 'Bond Paper A3', openingStock: -5 });

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_STOCK', productId: product.id }),
      empty,
    );

    assert.match(answer.answer, /gone negative/);
  });

  it('answers a rate question with what it last actually sold for', async () => {
    const { ctx, customer, product } = scenario;
    // The price list says 240; this bill goes out at 232.
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 232 }] },
      ctxOf(),
    );

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_RATE', productId: product.id }),
      empty,
    );

    assert.match(answer.answer, /232\.00 per Ream/);
    assert.match(answer.answer, /Sharma Stationery/);
    assert.ok(answer.details.some((d) => d.label === 'Price list' && d.value.includes('240')));
  });

  it('gives that party’s own last rate when the question named one', async () => {
    const { ctx, customer, product } = scenario;
    const walkIn = await createTestParty(ctx, { displayName: 'Cash Sale' });

    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 5, rate: 232 }] },
      ctxOf(),
    );
    // Later, and dearer, but to somebody else — the regular's price must win
    // when the regular is the one being asked about.
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: walkIn.id, items: [{ productId: product.id, quantity: 5, rate: 255 }] },
      ctxOf(),
    );

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_RATE', productId: product.id, partyId: customer.id }),
      empty,
    );

    assert.match(answer.answer, /232\.00/);
  });

  it('says an item has never been sold instead of inventing a rate', async () => {
    const { ctx, product } = scenario;
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PRODUCT_RATE', productId: product.id }),
      empty,
    );

    assert.match(answer.answer, /not been sold yet/);
  });

  // -------------------------------------------------------------------------
  // Totals
  // -------------------------------------------------------------------------

  it('totals the day’s sales and says which days it counted', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'SALES_TOTAL', period: 'TODAY' }),
      empty,
    );

    // 10 x 240 = 2400 + 12% = 2688.
    assert.match(answer.answer, /Sales today: ₹2,688\.00 across 1 bill\./);
    assert.ok(answer.details.some((d) => d.label === 'Period'));
  });

  it('leaves out a bill dated outside the period', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    // Ask about yesterday. Today's bill must not be in it.
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'SALES_TOTAL', period: 'YESTERDAY' }),
      empty,
    );

    assert.match(answer.answer, /No sales yesterday/);
  });

  it('refuses purchase figures to an account that may not see cost', async () => {
    const { ctx } = scenario;
    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PURCHASES_TOTAL', period: 'THIS_MONTH' }),
      empty,
      { canSeeCost: false },
    );

    assert.match(answer.answer, /not something this account can see/);
    assert.equal(answer.details.length, 0);
  });

  it('adds up what everybody owes, and names the largest', async () => {
    const { ctx } = scenario;
    await createTestParty(ctx, { displayName: 'Big Debtor', openingBalance: 50000 });
    await createTestParty(ctx, { displayName: 'Small Debtor', openingBalance: 1500 });
    // A credit balance is a payable and must not be netted into the receivable.
    await createTestParty(ctx, { displayName: 'Advance Paid', openingBalance: -9000 });

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'RECEIVABLES_TOTAL' }),
      empty,
    );

    assert.match(answer.answer, /₹51,500\.00 is owed to you, across 2 accounts/);
    assert.match(answer.details[0]!.value, /Big Debtor/);
  });

  it('reports what the shop owes as a positive amount owed out', async () => {
    const { ctx } = scenario;
    await createTestParty(ctx, {
      displayName: 'JK Mills',
      partyType: 'SUPPLIER',
      openingBalance: -9000,
    });

    const answer = await answerIntent(ctx.businessId, asked({ intent: 'PAYABLES_TOTAL' }), empty);
    assert.match(answer.answer, /You owe ₹9,000\.00, across 1 account\./);
  });

  it('describes the last bill on an account', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    const answer = await answerIntent(
      ctx.businessId,
      asked({ intent: 'PARTY_LAST_INVOICE', partyId: customer.id }),
      empty,
    );

    assert.match(answer.answer, /INV\/0001/);
    assert.match(answer.answer, /₹2,688\.00/);
    assert.match(answer.answer, /still unpaid/);
    assert.equal(answer.details[0]?.label, 'JK Copier A4 75gsm');
  });

  it('turns away anything that is not a question', async () => {
    const { ctx } = scenario;
    const answer = await answerIntent(ctx.businessId, asked({ intent: 'UNKNOWN' }), empty);

    assert.match(answer.answer, /has to be done on screen/);
  });

  // -------------------------------------------------------------------------
  // The promise the whole feature rests on
  // -------------------------------------------------------------------------

  it('writes absolutely nothing, whatever it is asked', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    /**
     * Row counts plus the mutable caches' own timestamps.
     *
     * Counting rows alone would miss an update in place — a balance recomputed
     * and saved, say — so `PartyBalance` and `ProductStock` are compared
     * whole. Those two are the rows a read path would be most tempted to
     * "helpfully" refresh.
     */
    const snapshot = async () => ({
      counts: await Promise.all([
        prisma.party.count(),
        prisma.product.count(),
        prisma.salesInvoice.count(),
        prisma.salesInvoiceItem.count(),
        prisma.purchaseInvoice.count(),
        prisma.payment.count(),
        prisma.creditDebitNote.count(),
        prisma.ledgerEntry.count(),
        prisma.stockMovement.count(),
        prisma.auditLog.count(),
        prisma.numberSequence.count(),
      ]),
      balances: await prisma.partyBalance.findMany({ orderBy: { partyId: 'asc' } }),
      stocks: await prisma.productStock.findMany({ orderBy: { productId: 'asc' } }),
      sequences: await prisma.numberSequence.findMany({ orderBy: { id: 'asc' } }),
    });

    const before = await snapshot();

    const everyIntent: Intent[] = [
      asked({ intent: 'PARTY_BALANCE', partyId: customer.id }),
      asked({ intent: 'PRODUCT_STOCK', productId: product.id }),
      asked({ intent: 'PRODUCT_RATE', productId: product.id, partyId: customer.id }),
      asked({ intent: 'SALES_TOTAL', period: 'THIS_MONTH' }),
      asked({ intent: 'PURCHASES_TOTAL', period: 'THIS_YEAR' }),
      asked({ intent: 'RECEIVABLES_TOTAL' }),
      asked({ intent: 'PAYABLES_TOTAL' }),
      asked({ intent: 'PARTY_LAST_INVOICE', partyId: customer.id }),
      asked({ intent: 'UNKNOWN' }),
    ];

    for (const intent of everyIntent) {
      await answerIntent(ctx.businessId, intent, empty, { canSeeCost: true });
    }

    const after = await snapshot();
    assert.deepEqual(after.counts, before.counts, 'no row was created or removed');
    assert.deepEqual(after.balances, before.balances, 'no balance was touched');
    assert.deepEqual(after.stocks, before.stocks, 'no stock figure was touched');
    // A read that allocated an invoice number would leave a gap in the series,
    // which GST does not forgive.
    assert.deepEqual(after.sequences, before.sequences, 'no number was allocated');
  });
});
