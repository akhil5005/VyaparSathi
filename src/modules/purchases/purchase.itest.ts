/**
 * Purchases against a real Postgres.
 *
 * The costing unit tests prove the arithmetic in isolation. This file proves it
 * survives the lock-read-write dance that keeps the moving average correct when
 * two receipts of the same product land at once.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { createTestParty, createTestProduct, setupBillingScenario } from '../../test-support/factories.js';
import { cancelPurchase, createPurchase } from './purchase.service.js';
import { claimInputCredit, getGstSummary, getPendingItc } from './itc.service.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });
const today = () => new Date();

describe('purchases (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  it('receives stock and credits the supplier ledger', async () => {
    const { ctx, supplier, product } = scenario;

    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/1234',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 240 }],
      },
      ctxOf(),
    );

    assert.equal(purchase.purchaseNumber, 'PUR/0001');
    assert.equal(purchase.taxableValue.toString(), '24000');
    assert.equal(purchase.grandTotal.toString(), '26880');

    // Stock in: 100 opening + 100 received.
    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '200');

    // Ledger: we owe the supplier, so the balance goes negative.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '-26880');

    const entry = await prisma.ledgerEntry.findFirst({ where: { voucherId: purchase.id } });
    assert.equal(entry!.credit.toString(), '26880');
  });

  it('blends the moving average across receipts', async () => {
    const { ctx, supplier, product } = scenario;

    // Opening: 100 reams at 200. Receive 100 at 240 -> average 220.
    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/1',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 240 }],
      },
      ctxOf(),
    );

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '200');
    assert.equal(stock!.avgCostPerBaseUnit.toString(), '220');
  });

  it('rolls freight into landed cost, but not GST when the credit is claimable', async () => {
    const { ctx, supplier } = scenario;
    const fresh = await createTestProduct(ctx, { name: 'Fresh Stock', openingStock: 0, openingCost: 0 });

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/2',
        supplierInvoiceDate: today(),
        items: [{ productId: fresh.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 240 }],
        freightCharges: 1000,
      },
      ctxOf(),
    );

    // (24000 taxable + 1000 freight) / 100 = 250. The 2880 of GST is recovered
    // as input credit, so it is not part of what the goods cost.
    const stock = await prisma.productStock.findUnique({ where: { productId: fresh.id } });
    assert.equal(stock!.avgCostPerBaseUnit.toString(), '250');
  });

  it('includes GST in cost when the credit is not available', async () => {
    const { ctx, supplier } = scenario;
    const fresh = await createTestProduct(ctx, { name: 'Blocked Credit', openingStock: 0, openingCost: 0 });

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/3',
        supplierInvoiceDate: today(),
        items: [{ productId: fresh.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 240 }],
        itcEligible: false,
      },
      ctxOf(),
    );

    // (24000 + 2880 tax) / 100 = 268.80 — the tax is a real cost here.
    const stock = await prisma.productStock.findUnique({ where: { productId: fresh.id } });
    assert.equal(stock!.avgCostPerBaseUnit.toString(), '268.8');
  });

  it('converts a kilogram purchase into reams of stock', async () => {
    const { ctx, supplier, product } = scenario;

    // The mill bills 100 kg; 1 kg = 0.4276 reams.
    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/KG-1',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.kg, rate: 100 }],
      },
      ctxOf(),
    );

    assert.equal(purchase.items[0]!.baseQuantity.toString(), '42.76');

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '142.76');
  });

  it('takes the incoming rate as the average when stock was negative', async () => {
    const { ctx, customer, supplier } = scenario;
    const scarce = await createTestProduct(ctx, { name: 'Oversold', openingStock: 0, openingCost: 0 });

    // Sell 20 with nothing on hand — normal here, he bills before entering the bill.
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: scarce.id, quantity: 20, rate: 300 }] },
      ctxOf(),
    );

    let stock = await prisma.productStock.findUnique({ where: { productId: scarce.id } });
    assert.equal(stock!.quantityOnHand.toString(), '-20');

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/NEG',
        supplierInvoiceDate: today(),
        items: [{ productId: scarce.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 250 }],
      },
      ctxOf(),
    );

    // Averaging against -20 would be nonsense, so the incoming rate wins.
    stock = await prisma.productStock.findUnique({ where: { productId: scarce.id } });
    assert.equal(stock!.quantityOnHand.toString(), '80');
    assert.equal(stock!.avgCostPerBaseUnit.toString(), '250');
  });

  it('keeps the average correct under concurrent receipts of one product', async () => {
    const { ctx, product } = scenario;

    // Five suppliers deliver the same product at once. The moving average is a
    // read-then-write, so without the row lock some of these updates get lost.
    const suppliers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createTestParty(ctx, { displayName: `Mill ${i}`, partyType: 'SUPPLIER' }),
      ),
    );

    await Promise.all(
      suppliers.map((supplier, i) =>
        createPurchase(
          ctx.businessId,
          ctx.userId,
          {
            partyId: supplier.id,
            supplierInvoiceNumber: `CONC/${i}`,
            supplierInvoiceDate: today(),
            items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 200 }],
          },
          ctxOf(),
        ),
      ),
    );

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    // 100 opening + 5 x 100 received.
    assert.equal(stock!.quantityOnHand.toString(), '600');
    // Everything came in at exactly the opening cost, so the average must not
    // have drifted. A lost update would show up here immediately.
    assert.equal(stock!.avgCostPerBaseUnit.toString(), '200');
  });

  it('rejects the same supplier bill entered twice', async () => {
    const { ctx, supplier, product } = scenario;

    const input = {
      partyId: supplier.id,
      supplierInvoiceNumber: 'JK/DUP',
      supplierInvoiceDate: today(),
      items: [{ productId: product.id, quantity: 10, unitId: ctx.unitIds.ream, rate: 240 }],
    };

    await createPurchase(ctx.businessId, ctx.userId, input, ctxOf());

    // Double entry doubles both stock and the credit claimed — the single most
    // common purchase data-entry error.
    await assert.rejects(
      createPurchase(ctx.businessId, ctx.userId, input, ctxOf()),
      /already entered as PUR\/0001/,
    );

    assert.equal(await prisma.purchaseInvoice.count(), 1);
  });

  it('flags a mismatch against the total printed on the bill', async () => {
    const { ctx, supplier, product } = scenario;

    const { warnings } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/MISMATCH',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 10, unitId: ctx.unitIds.ream, rate: 240 }],
        supplierGrandTotal: 3000, // we compute 2688
      },
      ctxOf(),
    );

    assert.ok(warnings.some((w) => w.code === 'SUPPLIER_TOTAL_MISMATCH'));
  });

  it('cancelling reverses stock and the supplier ledger', async () => {
    const { ctx, supplier, product } = scenario;

    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/CANCEL',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 50, unitId: ctx.unitIds.ream, rate: 240 }],
      },
      ctxOf(),
    );

    await cancelPurchase(ctx.businessId, ctx.userId, purchase.id, 'Goods refused', ctxOf());

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '100');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '0');
  });
});

describe('input tax credit (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  async function billAndBuy() {
    const { ctx, customer, supplier, product } = scenario;

    // Sell 100 at 300 -> 30000 taxable, 1800 CGST + 1800 SGST output.
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 100, rate: 300 }] },
      ctxOf(),
    );

    // Buy 100 at 200 -> 20000 taxable, 1200 CGST + 1200 SGST input.
    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/ITC',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    return purchase;
  }

  it('nets output tax against input credit in the GST summary', async () => {
    const { ctx } = scenario;
    await billAndBuy();

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const summary = await getGstSummary(ctx.businessId, { period });

    assert.equal(summary.sales.tax.cgst.toString(), '1800');
    assert.equal(summary.purchases.tax.cgst.toString(), '1200');

    // 1800 output less 1200 credit on each of CGST and SGST = 600 + 600 cash.
    assert.equal(summary.setOff.cashPayable.cgst.toString(), '600');
    assert.equal(summary.setOff.cashPayable.sgst.toString(), '600');
    assert.equal(summary.setOff.totalCashPayable.toString(), '1200');
    assert.equal(summary.setOff.totalCarriedForward.toString(), '0');
  });

  it('lists unclaimed credit and marks it claimed for a period', async () => {
    const { ctx } = scenario;
    const purchase = await billAndBuy();

    const pendingBefore = await getPendingItc(ctx.businessId);
    assert.equal(pendingBefore.count, 1);
    assert.equal(pendingBefore.totalCredit.toString(), '2400');

    const result = await claimInputCredit(
      ctx.businessId,
      ctx.userId,
      { period: '2026-08', purchaseIds: [purchase.id] },
      ctxOf(),
    );
    assert.equal(result.claimedCount, 1);
    assert.equal(result.creditClaimed.toString(), '2400');

    const pendingAfter = await getPendingItc(ctx.businessId);
    assert.equal(pendingAfter.count, 0);

    const reloaded = await prisma.purchaseInvoice.findUnique({ where: { id: purchase.id } });
    assert.equal(reloaded!.itcClaimed, true);
    assert.equal(reloaded!.itcClaimedIn, '2026-08');
  });

  it('refuses to claim the same credit twice', async () => {
    const { ctx } = scenario;
    const purchase = await billAndBuy();

    await claimInputCredit(
      ctx.businessId,
      ctx.userId,
      { period: '2026-08', purchaseIds: [purchase.id] },
      ctxOf(),
    );

    await assert.rejects(
      claimInputCredit(
        ctx.businessId,
        ctx.userId,
        { period: '2026-09', purchaseIds: [purchase.id] },
        ctxOf(),
      ),
      /already claimed/,
    );
  });

  it('excludes ineligible purchases from available credit', async () => {
    const { ctx, supplier, product } = scenario;

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/NOITC',
        supplierInvoiceDate: today(),
        items: [{ productId: product.id, quantity: 10, unitId: ctx.unitIds.ream, rate: 240 }],
        itcEligible: false,
      },
      ctxOf(),
    );

    const pending = await getPendingItc(ctx.businessId);
    assert.equal(pending.count, 0);
  });
});
