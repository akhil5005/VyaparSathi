/**
 * Turning what was read off a photograph into a draft the shop can confirm.
 *
 * The model call is not exercised here — this takes the extraction as given and
 * tests everything after it, which is where a scanned bill can quietly land on
 * the wrong supplier or the wrong product. The rule throughout is that an
 * uncertain match is offered, never applied.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { createTestParty, createTestProduct, makeGstin, setupBillingScenario } from '../../test-support/factories.js';
import { cleanAmount, parseIndianDate, resolveAgainstMasters } from './scanPurchase.service.js';

describe('scanned bill resolution (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  const bill = (over: Record<string, unknown> = {}) => ({
    supplierName: 'M/S J.K. PAPER MILLS LTD.',
    invoiceNumber: 'JK/8801',
    invoiceDate: '14/07/2026',
    lines: [
      { description: 'A4 COPIER 75 GSM', quantity: '100', unit: 'REAM', rate: '200', amount: '20000' },
    ],
    ...over,
  });

  it('matches the supplier through decoration the database does not have', async () => {
    const { ctx } = scenario;
    // The fixture's supplier is plain "JK Paper Mills"; the bill is not.
    const result = await resolveAgainstMasters(ctx.businessId, bill());

    assert.equal(result.supplier.match?.displayName, 'JK Paper Mills');
    assert.equal(result.supplier.match?.confident, true);
    assert.equal(result.supplier.nameOnBill, 'M/S J.K. PAPER MILLS LTD.');
  });

  it('prefers a GSTIN on the bill over any amount of name similarity', async () => {
    const { ctx } = scenario;
    const gstin = makeGstin('03');
    // Named nothing like the bill, but it is the same registration — and a
    // GSTIN is an identifier, which no string score should be able to beat.
    const real = await createTestParty(ctx, {
      displayName: 'Paperco Distributors',
      partyType: 'SUPPLIER',
      gstin,
    });
    const result = await resolveAgainstMasters(ctx.businessId, bill({ supplierGstin: gstin }));

    assert.equal(result.supplier.match?.partyId, real.id);
    assert.equal(result.supplier.match?.confident, true);
  });

  it('warns instead of guessing when the supplier is not on file', async () => {
    const { ctx } = scenario;
    const result = await resolveAgainstMasters(
      ctx.businessId,
      bill({ supplierName: 'Bharat Electricals' }),
    );

    assert.equal(result.supplier.match, null);
    assert.ok(result.warnings.some((w) => w.code === 'SUPPLIER_UNKNOWN'));
  });

  it('refuses confidence between two suppliers with near-identical names', async () => {
    const { ctx } = scenario;
    await createTestParty(ctx, { displayName: 'Verma Stationery', partyType: 'SUPPLIER' });
    await createTestParty(ctx, { displayName: 'Verma Stationers', partyType: 'SUPPLIER' });

    // Misspelled on the bill, so it matches neither exactly and sits a hair
    // from both. An exact match would deserve confidence; this must not get it.
    const result = await resolveAgainstMasters(
      ctx.businessId,
      bill({ supplierName: 'VERMA STATIONARY' }),
    );

    assert.ok(result.supplier.match, 'a candidate should still be offered');
    assert.equal(result.supplier.match?.confident, false);
    assert.ok(result.warnings.some((w) => w.code === 'SUPPLIER_UNCERTAIN'));
    assert.ok(result.supplier.candidates.length >= 2, 'both should be offered as choices');
  });

  it('never matches a customer as the supplier', async () => {
    const { ctx } = scenario;
    // The fixture's customer is named "Sharma Stationery"; a bill from a
    // similarly named *supplier* must not resolve onto the customer's account.
    const result = await resolveAgainstMasters(
      ctx.businessId,
      bill({ supplierName: 'Sharma Stationery' }),
    );

    assert.notEqual(result.supplier.match?.partyId, scenario.customer.id);
  });

  it('matches a product from the description printed on the line', async () => {
    const { ctx } = scenario;
    const result = await resolveAgainstMasters(ctx.businessId, bill());

    // The fixture product is "JK Copier A4 75gsm".
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0]!.match?.productId, scenario.product.id);
    assert.equal(result.lines[0]!.quantity, '100');
    assert.equal(result.lines[0]!.rate, '200');
  });

  it('flags an unmatched line rather than dropping it', async () => {
    const { ctx } = scenario;
    const result = await resolveAgainstMasters(
      ctx.businessId,
      bill({
        lines: [
          { description: 'A4 COPIER 75 GSM', quantity: '10', rate: '200' },
          { description: 'PACKING TAPE 2 INCH', quantity: '5', rate: '40' },
        ],
      }),
    );

    assert.equal(result.lines.length, 2, 'an unmatched line must survive to be corrected');
    assert.equal(result.lines[1]!.match, null);
    assert.ok(result.warnings.some((w) => w.code === 'PRODUCTS_UNMATCHED'));
  });

  it('will not silently accept a line with no quantity or rate', async () => {
    const { ctx } = scenario;
    const result = await resolveAgainstMasters(
      ctx.businessId,
      bill({ lines: [{ description: 'A4 COPIER 75 GSM', amount: '20000' }] }),
    );

    // These two set the moving-average cost. A derived guess here corrupts
    // every margin figure afterwards, so it is left blank and flagged.
    assert.equal(result.lines[0]!.quantity, null);
    assert.equal(result.lines[0]!.rate, null);
    assert.ok(result.warnings.some((w) => w.code === 'FIGURES_MISSING'));
  });

  it('says so when nothing readable came back', async () => {
    const { ctx } = scenario;
    const result = await resolveAgainstMasters(ctx.businessId, {
      notes: 'The photograph is too blurred to read.',
    });

    assert.equal(result.lines.length, 0);
    assert.ok(result.warnings.some((w) => w.code === 'NO_LINES'));
    assert.equal(result.notes, 'The photograph is too blurred to read.');
  });

  it('ignores another shop’s suppliers and products entirely', async () => {
    const { ctx } = scenario;
    // A second shop with the same supplier and a near-identical product.
    const other = await setupBillingScenario();
    await createTestProduct(other.ctx, { name: 'JK Copier A4 75gsm ream' });

    const result = await resolveAgainstMasters(ctx.businessId, bill());

    // Both shops have a supplier of this name — it must resolve to ours.
    assert.equal(result.supplier.match?.partyId, scenario.supplier.id);
    assert.ok(
      result.supplier.candidates.every((c) => c.partyId !== other.supplier.id),
      'their supplier must not appear even as a candidate',
    );

    const theirs = await prisma.product.findMany({
      where: { businessId: other.ctx.businessId },
      select: { id: true },
    });
    const theirIds = new Set(theirs.map((p) => p.id));
    assert.ok(result.lines[0]!.candidates.length > 0, 'ours should still match');
    assert.ok(result.lines[0]!.candidates.every((c) => !theirIds.has(c.productId)));
  });

  it('leaves a discontinued product out of the candidates', async () => {
    const { ctx, product } = scenario;
    await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });

    const result = await resolveAgainstMasters(ctx.businessId, bill());
    assert.equal(result.lines[0]!.match, null);
  });
});

describe('reading figures off a printed bill', () => {
  it('reads Indian dates day-first', () => {
    // 03/04/2026 is 3 April here, not 4 March. Getting this backwards puts the
    // credit in the wrong return period.
    assert.equal(parseIndianDate('03/04/2026'), '2026-04-03');
    assert.equal(parseIndianDate('14-07-26'), '2026-07-14');
    assert.equal(parseIndianDate('14 Jul 2026'), '2026-07-14');
    assert.equal(parseIndianDate('1.4.2026'), '2026-04-01');
  });

  it('returns null rather than a guess for anything it cannot read', () => {
    assert.equal(parseIndianDate('31/02/2026'), null, '31 February must not roll over');
    assert.equal(parseIndianDate('sometime last week'), null);
    assert.equal(parseIndianDate(''), null);
    assert.equal(parseIndianDate(undefined), null);
  });

  it('strips Indian number formatting so a Decimal can take it', () => {
    assert.equal(cleanAmount('1,25,000.50'), '125000.50');
    assert.equal(cleanAmount('₹ 20,000/-'), '20000');
    assert.equal(cleanAmount('200'), '200');
  });

  it('returns null for anything that is not a number', () => {
    assert.equal(cleanAmount('as agreed'), null);
    assert.equal(cleanAmount(''), null);
    assert.equal(cleanAmount(undefined), null);
  });
});
