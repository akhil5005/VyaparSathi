/**
 * Editing a product or a party after it has been used.
 *
 * Creating a master is easy; correcting one that already has invoices against
 * it is where the damage happens. Everything here is about the boundary between
 * "change it from now on" and "rewrite what already happened" — the second must
 * never occur, because an issued invoice has been given to a customer and
 * reported to the government.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { createTestParty, makeGstin, setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { updateParty } from './party.service.js';
import { createProduct, suggestKgConversion, updateProduct } from './product.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('editing masters (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  const sell = async (partyId: string) => {
    const { ctx, product } = scenario;
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId, items: [{ productId: product.id, quantity: 4, rate: 250 }] },
      ctxOf(),
    );
    return invoice;
  };

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  it('renames a product without touching what past invoices say it was called', async () => {
    const { ctx, customer, product } = scenario;
    const invoice = await sell(customer.id);

    await updateProduct(
      ctx.businessId,
      ctx.userId,
      product.id,
      { name: 'JK Copier A4 75gsm (new pack)' },
      ctxOf(),
    );

    const line = await prisma.salesInvoiceItem.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    // The line snapshotted the name at issue time; the bill in the customer's
    // hand and the bill on screen must still read the same.
    assert.equal(line.productName, 'JK Copier A4 75gsm');

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(updated.name, 'JK Copier A4 75gsm (new pack)');
  });

  it('clears a brand when an empty string is sent, rather than ignoring it', async () => {
    const { ctx, product } = scenario;
    await updateProduct(ctx.businessId, ctx.userId, product.id, { brand: 'JK Paper' }, ctxOf());
    await updateProduct(ctx.businessId, ctx.userId, product.id, { brand: '' }, ctxOf());

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(updated.brand, '');
  });

  it('refuses a rename that collides with another product', async () => {
    const { ctx, product } = scenario;
    const other = await prisma.product.create({
      data: {
        businessId: ctx.businessId,
        name: 'Century Maplitho A4',
        hsnCodeId: ctx.hsnCodeId,
        baseUnitId: ctx.unitIds.ream,
      },
    });

    await assert.rejects(
      updateProduct(ctx.businessId, ctx.userId, product.id, { name: other.name }, ctxOf()),
      /already exists/,
    );
  });

  it('changes the HSN for future bills and leaves issued tax alone', async () => {
    const { ctx, customer, product } = scenario;
    const before = await sell(customer.id);

    // A second HSN at a different slab — the realistic case is a product that
    // was coded to the wrong chapter all along.
    const cheaper = await prisma.hsnCode.create({
      data: {
        businessId: ctx.businessId,
        code: '4820',
        description: 'Registers and notebooks',
        taxRates: { create: { gstRate: 5, cessRate: 0, effectiveFrom: new Date('2020-01-01') } },
      },
    });

    await updateProduct(
      ctx.businessId,
      ctx.userId,
      product.id,
      { hsnCodeId: cheaper.id },
      ctxOf(),
    );

    const oldLine = await prisma.salesInvoiceItem.findFirstOrThrow({
      where: { invoiceId: before.id },
    });
    assert.equal(oldLine.hsnCode, '4802');
    assert.equal(oldLine.cgstRate.toString(), '6');

    const after = await sell(customer.id);
    const newLine = await prisma.salesInvoiceItem.findFirstOrThrow({
      where: { invoiceId: after.id },
    });
    assert.equal(newLine.hsnCode, '4820');
    assert.equal(newLine.cgstRate.toString(), '2.5');
  });

  it('keeps a discontinued product out of new bills but leaves its stock alone', async () => {
    const { ctx, customer, product } = scenario;

    await updateProduct(ctx.businessId, ctx.userId, product.id, { isActive: false }, ctxOf());

    await assert.rejects(sell(customer.id), /inactive|not active|discontinued/i);

    const stock = await prisma.productStock.findFirstOrThrow({ where: { productId: product.id } });
    assert.equal(stock.quantityOnHand.toString(), '100');
  });

  // -------------------------------------------------------------------------
  // Parties
  // -------------------------------------------------------------------------

  it('re-derives the state from a new GSTIN, switching the tax on the next bill', async () => {
    const { ctx, customer } = scenario;
    const punjabBill = await sell(customer.id);
    assert.equal(punjabBill.supplyType, 'INTRA_STATE');
    assert.equal(punjabBill.totalCgst.toString(), '60');

    // They move to Haryana and re-register there.
    await updateParty(
      ctx.businessId,
      ctx.userId,
      customer.id,
      { gstin: makeGstin('06') },
      ctxOf(),
    );

    const moved = await prisma.party.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(moved.stateCode, '06');
    assert.equal(moved.stateName, 'Haryana');

    const haryanaBill = await sell(customer.id);
    assert.equal(haryanaBill.supplyType, 'INTER_STATE');
    assert.equal(haryanaBill.totalIgst.toString(), '120');
    assert.equal(haryanaBill.totalCgst.toString(), '0');

    // And the bill issued before the move is untouched.
    const original = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: punjabBill.id } });
    assert.equal(original.supplyType, 'INTRA_STATE');
    assert.equal(original.partyStateCode, '03');
    assert.equal(original.totalCgst.toString(), '60');
  });

  it('clears a GSTIN when null is sent, and keeps the state it was given', async () => {
    const { ctx, customer } = scenario;
    assert.ok(customer.gstin, 'the fixture starts registered');

    await updateParty(
      ctx.businessId,
      ctx.userId,
      customer.id,
      { gstin: null, stateCode: '03' },
      ctxOf(),
    );

    const updated = await prisma.party.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(updated.gstin, null);
    assert.equal(updated.gstRegistrationType, 'UNREGISTERED');
    // Still needed — it is what decides CGST/SGST vs IGST on their next bill.
    assert.equal(updated.stateCode, '03');
  });

  it('leaves the GSTIN alone when it is simply not mentioned', async () => {
    const { ctx, customer } = scenario;

    await updateParty(ctx.businessId, ctx.userId, customer.id, { creditDays: 30 }, ctxOf());

    const updated = await prisma.party.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(updated.gstin, customer.gstin);
    assert.equal(updated.creditDays, 30);
  });

  it('rejects a GSTIN whose state contradicts the state code given with it', async () => {
    const { ctx, customer } = scenario;

    await assert.rejects(
      updateParty(
        ctx.businessId,
        ctx.userId,
        customer.id,
        { gstin: makeGstin('06'), stateCode: '03' },
        ctxOf(),
      ),
      /Haryana/,
    );
  });

  /**
   * A product counted in kilograms weighs one kilogram per base unit.
   *
   * `reamWeightKg` computes the weight of a *ream*, which is the base unit's
   * weight only when the base unit is a ream. Storing it against a kg-held
   * product produced two visible wrongs — "One kilogram weighs 2.3389 kg" on
   * the product screen, and a `grossWeightKg` that would declare 278 kg of
   * paper as 650 kg on an e-way bill.
   */
  it('does not give a kilogram the weight of a ream', async () => {
    const { ctx } = scenario;

    const kgProduct = await createProduct(
      ctx.businessId,
      ctx.userId,
      {
        name: 'Copier Paper FS 75gsm',
        hsnCodeId: ctx.hsnCodeId,
        baseUnitId: ctx.unitIds.kg,
        gsm: 75,
        sheetSize: 'A4',
        sheetsPerReam: 500,
      },
      ctxOf(),
    );

    assert.equal(
      kgProduct.weightPerBaseUnitKg?.toString(),
      '1',
      'one kilogram weighs one kilogram, whatever the paper spec says',
    );

    // And nothing invents a kg conversion for a product already held in kg.
    const units = await prisma.productUnit.findMany({
      where: { productId: kgProduct.id },
      include: { unit: true },
    });
    assert.equal(units.length, 1);
    assert.equal(units[0]!.unit.uqc, 'KGS');
    assert.equal(units[0]!.conversionToBase.toString(), '1');

    const suggestion = await suggestKgConversion(ctx.businessId, kgProduct.id);
    assert.equal(suggestion.available, false);
    assert.match(suggestion.reason!, /already counted in kilograms/);
  });

  it('still derives a ream weight when the base unit is a ream', async () => {
    const { ctx } = scenario;

    const reamProduct = await createProduct(
      ctx.businessId,
      ctx.userId,
      {
        name: 'Copier Paper A4 75gsm ream',
        hsnCodeId: ctx.hsnCodeId,
        baseUnitId: ctx.unitIds.ream,
        gsm: 75,
        sheetSize: 'A4',
        sheetsPerReam: 500,
      },
      ctxOf(),
    );

    // 75 g/m² × (0.210 × 0.297 m²) × 500 ÷ 1000 = 2.3389 kg
    assert.equal(reamProduct.weightPerBaseUnitKg?.toString(), '2.3389');

    const suggestion = await suggestKgConversion(ctx.businessId, reamProduct.id);
    assert.equal(suggestion.available, true);
    assert.equal(
      suggestion.explanation,
      'One ream weighs 2.3389 kg, so 1 kg = 0.4276 ream.',
      'both halves of the sentence must name the same unit as the figure',
    );
  });

  it('will not edit a party belonging to another shop', async () => {
    const other = await setupBillingScenario();
    const theirs = await createTestParty(other.ctx, { displayName: 'Their customer' });

    await assert.rejects(
      updateParty(
        scenario.ctx.businessId,
        scenario.ctx.userId,
        theirs.id,
        { displayName: 'Renamed by a stranger' },
        ctxOf(),
      ),
      /not found/i,
    );

    const untouched = await prisma.party.findUniqueOrThrow({ where: { id: theirs.id } });
    assert.equal(untouched.displayName, 'Their customer');
  });

  it('will not edit a product belonging to another shop', async () => {
    const other = await setupBillingScenario();

    await assert.rejects(
      updateProduct(
        scenario.ctx.businessId,
        scenario.ctx.userId,
        other.product.id,
        { name: 'Renamed by a stranger' },
        ctxOf(),
      ),
      /not found/i,
    );

    const untouched = await prisma.product.findUniqueOrThrow({ where: { id: other.product.id } });
    assert.equal(untouched.name, other.product.name);
  });
});
