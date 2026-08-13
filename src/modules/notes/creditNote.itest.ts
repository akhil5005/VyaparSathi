/**
 * Credit and debit notes against a real Postgres.
 *
 * The two things this file exists to prove:
 *   1. A note reverses tax at the ORIGINAL invoice's rate, not today's master.
 *   2. You cannot credit the same goods twice.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { createPurchase } from '../purchases/purchase.service.js';
import { getGstSummary } from '../purchases/itc.service.js';
import { cancelNote, createNote, getCreditableLines, listNotes } from './creditNote.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('credit and debit notes (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** Sells 10 reams at 250 -> 2500 taxable, 150+150 tax, 2800 total. */
  async function sell(quantity = 10) {
    const { ctx, customer, product } = scenario;
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity, rate: 250 }] },
      ctxOf(),
    );
    return invoice;
  }

  it('a sales return credits the customer and puts stock back', async () => {
    const { ctx, customer, product } = scenario;
    const invoice = await sell();

    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'DAMAGED_GOODS',
        reasonNote: '4 reams water damaged',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 4 }],
      },
      ctxOf(),
    );

    // 4 x 250 = 1000 taxable, 12% -> 60 + 60, total 1120.
    assert.equal(note.noteNumber, 'CN/0001');
    assert.equal(note.status, 'ISSUED');
    assert.equal(note.taxableValue.toString(), '1000');
    assert.equal(note.totalCgst.toString(), '60');
    assert.equal(note.grandTotal.toString(), '1120');
    assert.equal(note.originalInvoiceNumber, 'INV/0001');
    assert.equal(note.affectsStock, true);

    // Customer owes 2800 - 1120.
    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '1680');

    // 100 opening - 10 sold + 4 returned.
    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '94');

    const movement = await prisma.stockMovement.findFirst({
      where: { referenceId: note.id },
    });
    assert.equal(movement!.movementType, 'SALES_RETURN_IN');
    assert.equal(movement!.baseQuantity.toString(), '4');
  });

  it('credits tax at the original rate even after the HSN rate changes', async () => {
    const { ctx } = scenario;
    const invoice = await sell();

    // The Council revises paper from 12% to 5%, effective tomorrow.
    await prisma.hsnTaxRate.updateMany({
      where: { hsnCodeId: ctx.hsnCodeId },
      data: { effectiveTo: new Date(Date.now() - 1000) },
    });
    await prisma.hsnTaxRate.create({
      data: {
        hsnCodeId: ctx.hsnCodeId,
        gstRate: 5,
        cessRate: 0,
        effectiveFrom: new Date(Date.now() - 500),
      },
    });

    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );

    // Goods were sold at 12%, so the credit must reverse 12% — crediting 5%
    // would leave 7% of tax reported but never collected.
    assert.equal(note.totalCgst.toString(), '150');
    assert.equal(note.totalSgst.toString(), '150');
    assert.equal(note.grandTotal.toString(), '2800');
    assert.equal(note.items[0]!.cgstRate.toString(), '6');
  });

  it('refuses to credit more than was invoiced', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 15 }],
        },
        ctxOf(),
      ),
      /only 10 Ream .* remain to be returned/,
    );

    assert.equal(await prisma.creditDebitNote.count(), 0);
  });

  it('refuses to credit the same goods twice across separate notes', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 6 }],
      },
      ctxOf(),
    );

    // 4 left. Asking for 5 must fail.
    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 5 }],
        },
        ctxOf(),
      ),
      /already credited 6/,
    );

    // But the remaining 4 is fine.
    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 4 }],
      },
      ctxOf(),
    );
    assert.equal(note.noteNumber, 'CN/0002');
  });

  it('reports what is still creditable on an invoice', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 3 }],
      },
      ctxOf(),
    );

    const result = await getCreditableLines(ctx.businessId, invoice.id);
    assert.equal(result.lines[0]!.invoicedQuantity.toString(), '10');
    assert.equal(result.lines[0]!.alreadyCredited.toString(), '3');
    assert.equal(result.lines[0]!.creditableQuantity.toString(), '7');
  });

  it('a rate-reduction note moves money but not goods', async () => {
    const { ctx, customer, product } = scenario;
    const invoice = await sell(10);

    // Agreed a ₹20/ream reduction after the sale. The credit is the difference.
    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'RATE_DIFFERENCE',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10, rate: 20 }],
      },
      ctxOf(),
    );

    assert.equal(note.affectsStock, false);
    assert.equal(note.taxableValue.toString(), '200');
    assert.equal(note.grandTotal.toString(), '224');

    // Stock untouched — nothing came back.
    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '90');
    assert.equal(await prisma.stockMovement.count({ where: { referenceId: note.id } }), 0);

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '2576'); // 2800 - 224
  });

  it('a rate-difference note is not capped by the return ceiling', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    // Full ten reams returned…
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );

    // …a money-only correction against the same line is still legitimate,
    // because it is not a second movement of goods.
    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'CORRECTION',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10, rate: 5 }],
      },
      ctxOf(),
    );
    assert.equal(note.affectsStock, false);
  });

  it('a money-only note does not consume return quota, in either order', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    // Rate correction FIRST — this must not eat into what can be returned.
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'RATE_DIFFERENCE',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10, rate: 20 }],
      },
      ctxOf(),
    );

    const creditable = await getCreditableLines(ctx.businessId, invoice.id);
    assert.equal(creditable.lines[0]!.creditableQuantity.toString(), '10');

    // All ten reams can still physically come back.
    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );
    assert.equal(note.affectsStock, true);
  });

  it('caps the same product spread over two invoice lines by its invoice total', async () => {
    const { ctx, customer, product } = scenario;

    // One product, two lines at different rates — legitimate, and the reason
    // the ceiling is computed per product rather than per line.
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [
          { productId: product.id, quantity: 6, rate: 250 },
          { productId: product.id, quantity: 4, rate: 240 },
        ],
      },
      ctxOf(),
    );

    // 10 invoiced in total. Returning 6 + 4 across both lines is fine.
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [
          { invoiceItemId: invoice.items[0]!.id, quantity: 6 },
          { invoiceItemId: invoice.items[1]!.id, quantity: 4 },
        ],
      },
      ctxOf(),
    );

    // Nothing left to return.
    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 1 }],
        },
        ctxOf(),
      ),
      /only 0 Ream/,
    );
  });

  it('stops one note from over-returning a product across its own lines', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [
          { productId: product.id, quantity: 6, rate: 250 },
          { productId: product.id, quantity: 4, rate: 240 },
        ],
      },
      ctxOf(),
    );

    // 6 + 6 = 12 against 10 invoiced — must fail on the second line, even
    // though neither line alone exceeds its own quantity.
    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          items: [
            { invoiceItemId: invoice.items[0]!.id, quantity: 6 },
            { invoiceItemId: invoice.items[1]!.id, quantity: 6 },
          ],
        },
        ctxOf(),
      ),
      /only 4 Ream/,
    );

    assert.equal(await prisma.creditDebitNote.count(), 0);
  });

  it('a debit note against a sale increases what the customer owes', async () => {
    const { ctx, customer } = scenario;
    const invoice = await sell(10);

    // Undercharged by ₹10/ream.
    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'DEBIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'RATE_DIFFERENCE',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10, rate: 10 }],
      },
      ctxOf(),
    );

    assert.equal(note.noteNumber, 'DN/0001');
    assert.equal(note.grandTotal.toString(), '112');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '2912'); // 2800 + 112
  });

  it('a purchase return sends stock back and reduces what we owe the mill', async () => {
    const { ctx, supplier, product } = scenario;

    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/RET',
        supplierInvoiceDate: new Date(),
        items: [{ productId: product.id, quantity: 50, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    // 50 x 200 = 10000 taxable, 1200 tax, 11200 owed. Stock 100 + 50 = 150.
    let balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '-11200');

    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'DEBIT_NOTE',
        againstPurchaseInvoiceId: purchase.id,
        reason: 'PURCHASE_RETURN',
        reasonNote: '20 reams short on delivery',
        items: [{ invoiceItemId: purchase.items[0]!.id, quantity: 20 }],
      },
      ctxOf(),
    );

    // 20 x 200 = 4000 taxable, 480 tax, 4480 off what we owe.
    assert.equal(note.grandTotal.toString(), '4480');

    balance = await prisma.partyBalance.findUnique({ where: { partyId: supplier.id } });
    assert.equal(balance!.currentBalance.toString(), '-6720');

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '130');

    const movement = await prisma.stockMovement.findFirst({ where: { referenceId: note.id } });
    assert.equal(movement!.movementType, 'PURCHASE_RETURN_OUT');
    assert.equal(movement!.baseQuantity.toString(), '-20');
  });

  it('refuses a credit note against a purchase, pointing at the right instrument', async () => {
    const { ctx, supplier, product } = scenario;

    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/X',
        supplierInvoiceDate: new Date(),
        items: [{ productId: product.id, quantity: 10, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstPurchaseInvoiceId: purchase.id,
          reason: 'PURCHASE_RETURN',
          items: [{ invoiceItemId: purchase.items[0]!.id, quantity: 5 }],
        },
        ctxOf(),
      ),
      /raise a debit note against the purchase/,
    );
  });

  it('refuses a note against a draft or cancelled invoice', async () => {
    const { ctx, customer, product } = scenario;

    const { invoice: draft } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [{ productId: product.id, quantity: 5, rate: 250 }],
        issue: false,
      },
      ctxOf(),
    );

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: draft.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: draft.items[0]!.id, quantity: 1 }],
        },
        ctxOf(),
      ),
      /only be raised against an issued document/,
    );
  });

  it('refuses a note dated before the invoice it credits', async () => {
    const { ctx } = scenario;
    const invoice = await sell();

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          noteDate: new Date(Date.UTC(2020, 0, 1)),
          items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 1 }],
        },
        ctxOf(),
      ),
      /cannot be dated before/,
    );
  });

  it('refuses a line belonging to a different invoice', async () => {
    const { ctx } = scenario;
    const first = await sell();
    const second = await sell();

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: first.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: second.items[0]!.id, quantity: 1 }],
        },
        ctxOf(),
      ),
      /does not belong to/,
    );
  });

  it('rolls back completely when the transaction fails', async () => {
    const { ctx, customer, product } = scenario;
    const invoice = await sell();

    await prisma.numberSequence.updateMany({
      where: { businessId: ctx.businessId, documentType: 'CREDIT_NOTE' },
      data: { prefix: 'A-VERY-LONG-PREFIX/', suffix: '/2026-27' },
    });

    await assert.rejects(
      createNote(
        ctx.businessId,
        ctx.userId,
        {
          noteType: 'CREDIT_NOTE',
          againstSalesInvoiceId: invoice.id,
          reason: 'SALES_RETURN',
          items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 4 }],
        },
        ctxOf(),
      ),
      /maximum of 16/,
    );

    assert.equal(await prisma.creditDebitNote.count(), 0);

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '90'); // unchanged by the failure

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '2800');
  });

  it('cancelling a note reverses its stock and ledger effect', async () => {
    const { ctx, customer, product } = scenario;
    const invoice = await sell();

    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 4 }],
      },
      ctxOf(),
    );

    await cancelNote(ctx.businessId, ctx.userId, note.id, 'Raised in error', ctxOf());

    const reloaded = await prisma.creditDebitNote.findUnique({ where: { id: note.id } });
    assert.equal(reloaded!.status, 'CANCELLED');
    assert.equal(reloaded!.noteNumber, 'CN/0001'); // number is not released

    const stock = await prisma.productStock.findUnique({ where: { productId: product.id } });
    assert.equal(stock!.quantityOnHand.toString(), '90');

    const balance = await prisma.partyBalance.findUnique({ where: { partyId: customer.id } });
    assert.equal(balance!.currentBalance.toString(), '2800');
  });

  it('a cancelled note frees the credited quantity again', async () => {
    const { ctx } = scenario;
    const invoice = await sell(10);

    const { note } = await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );
    await cancelNote(ctx.businessId, ctx.userId, note.id, 'Wrong quantity', ctxOf());

    // Only ISSUED notes count toward the ceiling.
    const result = await getCreditableLines(ctx.businessId, invoice.id);
    assert.equal(result.lines[0]!.creditableQuantity.toString(), '10');
  });

  it('lists notes scoped to the business', async () => {
    const { ctx } = scenario;
    const invoice = await sell();
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 1 }],
      },
      ctxOf(),
    );

    assert.equal((await listNotes(ctx.businessId, {})).total, 1);

    const other = await setupBillingScenario();
    assert.equal((await listNotes(other.ctx.businessId, {})).total, 0);
  });

  it('nets notes into the GST summary on both sides', async () => {
    const { ctx, supplier, product } = scenario;

    // Output: sell 100 at 300 -> 1800 CGST + 1800 SGST.
    const invoice = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: scenario.customer.id,
        items: [{ productId: product.id, quantity: 100, rate: 300 }],
      },
      ctxOf(),
    ).then((r) => r.invoice);

    // Input: buy 100 at 200 -> 1200 CGST + 1200 SGST.
    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/SUM',
        supplierInvoiceDate: new Date(),
        items: [{ productId: product.id, quantity: 100, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    // Customer returns 10 -> output tax down by 180 CGST + 180 SGST.
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );

    // We return 10 to the mill -> input credit down by 120 CGST + 120 SGST.
    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'DEBIT_NOTE',
        againstPurchaseInvoiceId: purchase.id,
        reason: 'PURCHASE_RETURN',
        items: [{ invoiceItemId: purchase.items[0]!.id, quantity: 10 }],
      },
      ctxOf(),
    );

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const summary = await getGstSummary(ctx.businessId, { period });

    // Output 1800 - 180 = 1620. Input 1200 - 120 = 1080. Cash 540 per head.
    assert.equal(summary.setOff.outputTax.cgst.toString(), '1620');
    assert.equal(summary.setOff.inputCredit.cgst.toString(), '1080');
    assert.equal(summary.setOff.cashPayable.cgst.toString(), '540');
    assert.equal(summary.setOff.totalCashPayable.toString(), '1080');

    // The raw invoice figures are still reported unchanged, so the netting is
    // auditable rather than hidden.
    assert.equal(summary.sales.tax.cgst.toString(), '1620');
    assert.equal(summary.notes.salesCreditNotes.cgst.toString(), '180');
    assert.equal(summary.notes.purchaseReturns.cgst.toString(), '120');
  });
});
