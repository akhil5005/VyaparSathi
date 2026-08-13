/**
 * Sales invoicing against a real Postgres.
 *
 * The unit tests prove the tax arithmetic. This file proves the *transaction*:
 * that issuing an invoice moves stock, writes the ledger and updates the
 * balance together, and that when anything fails none of it happened.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import {
  createTestParty,
  createTestProduct,
  setupBillingScenario,
} from '../../test-support/factories.js';
import {
  cancelSalesInvoice,
  createSalesInvoice,
  listSalesInvoices,
} from './salesInvoice.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('sales invoice (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  it('issuing writes invoice, stock, ledger and balance in one go', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    // 10 x 240 = 2400 taxable, 12% intra-state -> 144 + 144, total 2688
    assert.equal(invoice.status, 'ISSUED');
    assert.equal(invoice.invoiceNumber, 'INV/0001');
    assert.equal(invoice.supplyType, 'INTRA_STATE');
    assert.equal(invoice.taxableValue.toString(), '2400');
    assert.equal(invoice.totalCgst.toString(), '144');
    assert.equal(invoice.totalSgst.toString(), '144');
    assert.equal(invoice.totalIgst.toString(), '0');
    assert.equal(invoice.grandTotal.toString(), '2688');
    assert.equal(invoice.amountInWords, 'Rupees Two Thousand Six Hundred Eighty Eight Only');

    // Stock: 100 on hand, 10 sold.
    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '90');

    const movement = await prisma.stockMovement.findFirst({
      where: { referenceId: invoice.id },
    });
    assert.equal(movement!.movementType, 'SALE_OUT');
    assert.equal(movement!.baseQuantity.toString(), '-10');
    assert.equal(movement!.balanceAfter.toString(), '90');

    // Ledger: the customer now owes the grand total.
    const entry = await prisma.ledgerEntry.findFirst({ where: { voucherId: invoice.id } });
    assert.equal(entry!.voucherType, 'SALES_INVOICE');
    assert.equal(entry!.debit.toString(), '2688');
    assert.equal(entry!.runningBalance.toString(), '2688');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '2688');
  });

  it('charges IGST when the customer is outside the state', async () => {
    const { ctx, product } = scenario;
    const outsider = await createTestParty(ctx, {
      displayName: 'Delhi Traders',
      stateCode: '07',
    });

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: outsider.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    assert.equal(invoice.supplyType, 'INTER_STATE');
    assert.equal(invoice.totalIgst.toString(), '288');
    assert.equal(invoice.totalCgst.toString(), '0');
    // Same money either way — only the heads differ.
    assert.equal(invoice.grandTotal.toString(), '2688');
  });

  it('records cost of goods from the weighted average at the time of sale', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    // Opening cost is 200/ream, so 10 reams cost 2000 against 2400 of revenue.
    assert.equal(invoice.costOfGoods!.toString(), '2000');
    assert.equal(invoice.items[0]!.costPerBaseUnit!.toString(), '200');
  });

  it('converts a non-base unit into base units for stock', async () => {
    const { ctx, customer, product } = scenario;

    // 3 packets, 5 reams each = 15 reams off the shelf.
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [{ productId: product.id, quantity: 3, unitId: ctx.unitIds.packet, rate: 1200 }],
      },
      ctxOf(),
    );

    assert.equal(invoice.items[0]!.baseQuantity.toString(), '15');
    assert.equal(invoice.items[0]!.conversionToBase.toString(), '5');

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '85');
  });

  it('a draft touches nothing but the invoice table', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [{ productId: product.id, quantity: 10, rate: 240 }],
        issue: false,
      },
      ctxOf(),
    );

    assert.equal(invoice.status, 'DRAFT');
    assert.equal(invoice.invoiceNumber, null);

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '100');
    assert.equal(await prisma.ledgerEntry.count(), 0);
    assert.equal(await prisma.stockMovement.count(), 0);
  });

  it('rolls back everything when the transaction fails part-way', async () => {
    const { ctx, customer, product } = scenario;

    // Force a failure *after* stock and ledger would have been written, by
    // making number allocation produce an over-long document number.
    await prisma.numberSequence.updateMany({
      where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
      data: { prefix: 'A-VERY-LONG-PREFIX/', suffix: '/2026-27' },
    });

    await assert.rejects(
      createSalesInvoice(
        ctx.businessId,
        ctx.userId,
        { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
        ctxOf(),
      ),
      /maximum of 16/,
    );

    // Nothing at all should have landed.
    assert.equal(await prisma.salesInvoice.count(), 0);
    assert.equal(await prisma.stockMovement.count(), 0);
    assert.equal(await prisma.ledgerEntry.count(), 0);

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '100');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '0');
  });

  it('issues concurrent invoices without duplicating numbers or losing stock', async () => {
    const { ctx, customer, product } = scenario;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        createSalesInvoice(
          ctx.businessId,
          ctx.userId,
          { partyId: customer.id, items: [{ productId: product.id, quantity: 2, rate: 240 }] },
          ctxOf(),
        ),
      ),
    );

    const numbers = results.map((r) => r.invoice.invoiceNumber);
    assert.equal(new Set(numbers).size, 10, `duplicate numbers: ${numbers.join(', ')}`);

    // 10 invoices x 2 reams = 20 off a starting 100. A lost update here would
    // leave more than 80 on the shelf.
    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '80');

    // And the balance must be the exact sum, not a partially-lost total.
    // Each invoice is 480 + 57.60 tax = 537.60, rounded to 538 per GST rules —
    // the rounding happens per invoice, not on the total, so it is 5380.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '5380');
  });

  it('warns but still bills when stock would go negative', async () => {
    const { ctx, customer } = scenario;
    const scarce = await createTestProduct(ctx, { name: 'Almost Gone', openingStock: 5 });

    const { invoice, warnings } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: scarce.id, quantity: 20, rate: 100 }] },
      ctxOf(),
    );

    // He bills before entering the purchase — refusing the sale would be worse.
    assert.equal(invoice.status, 'ISSUED');
    assert.ok(warnings.some((w) => w.code === 'NEGATIVE_STOCK'));

    const stock = await prisma.productStock.findUnique({ where: { productId: scarce.id } });
    assert.equal(stock!.quantityOnHand.toString(), '-15');
  });

  it('refuses to bill a product whose HSN has no rate on the invoice date', async () => {
    const { ctx, customer } = scenario;

    const bareHsn = await prisma.hsnCode.create({
      data: { businessId: ctx.businessId, code: '9999', description: 'No rate configured' },
    });
    const product = await prisma.product.create({
      data: {
        businessId: ctx.businessId,
        name: 'Unrated Item',
        hsnCodeId: bareHsn.id,
        baseUnitId: ctx.unitIds.ream,
        defaultSaleRate: 100,
        defaultSaleUnitId: ctx.unitIds.ream,
      },
    });

    await assert.rejects(
      createSalesInvoice(
        ctx.businessId,
        ctx.userId,
        { partyId: customer.id, items: [{ productId: product.id, quantity: 1, rate: 100 }] },
        ctxOf(),
      ),
      /No GST rate is configured/,
    );

    assert.equal(await prisma.salesInvoice.count(), 0);
  });

  it('cancelling reverses stock and ledger with contra entries, keeping the number', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );

    await cancelSalesInvoice(ctx.businessId, ctx.userId, invoice.id, 'Wrong customer', ctxOf());

    const reloaded = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    assert.equal(reloaded!.status, 'CANCELLED');
    // The number is deliberately NOT released — a gap is a filing problem.
    assert.equal(reloaded!.invoiceNumber, 'INV/0001');

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '100');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '0');

    // The original ledger entry survives; a contra explains the reversal.
    const entries = await prisma.ledgerEntry.findMany({ orderBy: { createdAt: 'asc' } });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.debit.toString(), '2688');
    assert.equal(entries[1]!.credit.toString(), '2688');
  });

  it('deletes an unissued draft outright rather than cancelling it', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [{ productId: product.id, quantity: 1, rate: 100 }],
        issue: false,
      },
      ctxOf(),
    );

    const result = await cancelSalesInvoice(ctx.businessId, ctx.userId, invoice.id, 'Mistake', ctxOf());
    assert.equal(result.deleted, true);
    assert.equal(await prisma.salesInvoice.count(), 0);
  });

  it('lists only unpaid invoices when asked', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice: paid } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 1, rate: 100 }] },
      ctxOf(),
    );
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 2, rate: 100 }] },
      ctxOf(),
    );

    await prisma.salesInvoice.update({
      where: { id: paid.id },
      data: { amountPaid: paid.grandTotal },
    });

    const result = await listSalesInvoices(ctx.businessId, { unpaidOnly: true });
    assert.equal(result.invoices.length, 1);
    assert.notEqual(result.invoices[0]!.id, paid.id);
  });

  it('scopes every read to the caller business', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 1, rate: 100 }] },
      ctxOf(),
    );

    const other = await setupBillingScenario();
    const result = await listSalesInvoices(other.ctx.businessId, {});
    assert.equal(result.total, 0);
  });
});
