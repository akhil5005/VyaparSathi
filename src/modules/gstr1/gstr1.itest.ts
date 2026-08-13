/**
 * GSTR-1 against a real Postgres.
 *
 * The pure builder is tested exhaustively next door; this file exists to prove
 * the *query* is right, which is the half that silently omits things:
 *   - a cancelled invoice is out of every section but still counted in doc_issue
 *   - a note against a purchase is the supplier's sale, not ours
 *   - a draft is not a supply
 *   - another shop's invoices never appear in ours
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import {
  createTestBusiness,
  createTestParty,
  createTestProduct,
  setupBillingScenario,
} from '../../test-support/factories.js';
import { cancelSalesInvoice, createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { createPurchase } from '../purchases/purchase.service.js';
import { createNote } from '../notes/creditNote.service.js';
import { buildGstr1 } from './gstr1.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

/// A date inside the period under test, and one safely outside it.
const IN_PERIOD = new Date(Date.UTC(2026, 6, 15));
const PERIOD = '2026-07';
const NEXT_MONTH = new Date(Date.UTC(2026, 7, 2));

describe('GSTR-1 (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** 10 reams at 250 = 2500 taxable; the test HSN is 12%, so 150 + 150. */
  async function sell(
    partyId: string,
    opts: { quantity?: number; rate?: number; date?: Date; issue?: boolean } = {},
  ) {
    const { ctx, product } = scenario;
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId,
        invoiceDate: opts.date ?? IN_PERIOD,
        items: [{ productId: product.id, quantity: opts.quantity ?? 10, rate: opts.rate ?? 250 }],
        ...(opts.issue === false ? { issue: false } : {}),
      },
      ctxOf(),
    );
    return invoice;
  }

  it('puts a registered customer in B2B with the combined rate', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id);

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.fp, '072026');
    assert.equal(json.b2b?.length, 1);
    assert.equal(json.b2b![0]!.ctin, customer.gstin);
    assert.equal(json.b2b![0]!.inv.length, 1);

    const item = json.b2b![0]!.inv[0]!.itms[0]!.itm_det;
    assert.equal(item.rt, 12);
    assert.equal(item.txval, 2500);
    assert.equal(item.camt, 150);
    assert.equal(item.samt, 150);
    assert.equal(item.iamt, 0);

    assert.equal(summary.counts.b2bInvoices, 1);
    assert.equal(summary.totals.taxableValue, '2500.00');
    assert.equal(summary.totals.invoiceValue, '2800.00');
    assert.equal(json.b2cs, undefined);
  });

  it('puts a walk-in customer with no GSTIN in B2CS, with no invoice number', async () => {
    const { ctx } = scenario;
    const walkIn = await createTestParty(ctx, { displayName: 'Cash sale', gstin: null });
    await sell(walkIn.id);

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.b2b, undefined);
    assert.equal(json.b2cs?.length, 1);
    assert.equal(json.b2cs![0]!.txval, 2500);
    assert.equal(json.b2cs![0]!.sply_ty, 'INTRA');
    assert.equal(summary.counts.b2csRows, 1);
    assert.ok(!JSON.stringify(json.b2cs).includes('INV/'));
  });

  it('reports a large inter-state cash sale invoice-wise in B2CL', async () => {
    const { ctx } = scenario;
    const haryanaCash = await createTestParty(ctx, {
      displayName: 'Delhi trader',
      gstin: null,
      stateCode: '06',
    });
    // 100 reams at 2000 = 2,00,000 taxable — comfortably over the threshold.
    await sell(haryanaCash.id, { quantity: 100, rate: 2000 });

    const { json } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.b2cl?.length, 1);
    assert.equal(json.b2cl![0]!.pos, '06');
    assert.equal(json.b2cl![0]!.inv[0]!.itms[0]!.itm_det.iamt, 24_000);
    assert.equal(json.b2cs, undefined);
  });

  it('excludes a cancelled invoice from every section but still counts it in doc_issue', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id);
    const scrapped = await sell(customer.id);
    await cancelSalesInvoice(ctx.businessId, ctx.userId, scrapped.id, 'Wrong party', ctxOf());

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    // One live invoice in B2B...
    assert.equal(json.b2b![0]!.inv.length, 1);
    assert.equal(summary.totals.taxableValue, '2500.00');

    // ...but both numbers accounted for, or the portal sees a gap.
    const series = json.doc_issue!.doc_det.find((d) => d.doc_num === 1)!.docs[0]!;
    assert.equal(series.totnum, 2);
    assert.equal(series.cancel, 1);
    assert.equal(series.net_issue, 1);
    assert.equal(series.from, 'INV/0001');
    assert.equal(series.to, 'INV/0002');
    assert.equal(summary.counts.cancelledInvoices, 1);
  });

  it('leaves a draft out entirely — nothing was supplied', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id, { issue: false });

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.b2b, undefined);
    assert.equal(json.doc_issue, undefined);
    assert.equal(summary.totals.taxableValue, '0.00');
    assert.ok(summary.warnings.some((w) => w.code === 'EMPTY_PERIOD'));
  });

  it('ignores invoices outside the period', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id);
    await sell(customer.id, { date: NEXT_MONTH });

    const { json } = await buildGstr1(ctx.businessId, PERIOD);
    assert.equal(json.b2b![0]!.inv.length, 1);
    assert.equal(json.b2b![0]!.inv[0]!.idt, '15-07-2026');
  });

  it('reports a sales credit note in CDNR and nets it out of the totals', async () => {
    const { ctx, customer } = scenario;
    const invoice = await sell(customer.id);

    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'SALES_RETURN',
        noteDate: IN_PERIOD,
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 4 }],
      },
      ctxOf(),
    );

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.cdnr?.length, 1);
    assert.equal(json.cdnr![0]!.nt[0]!.ntty, 'C');
    assert.equal(json.cdnr![0]!.nt[0]!.itms[0]!.itm_det.txval, 1000);

    // 2500 sold less 1000 returned.
    assert.equal(summary.totals.taxableValue, '1500.00');
    assert.equal(summary.counts.creditNotes, 1);

    // The HSN summary is net too, or it would not tie to the totals.
    assert.equal(json.hsn!.data[0]!.txval, 1500);

    const credits = json.doc_issue!.doc_det.find((d) => d.doc_num === 5)!.docs[0]!;
    assert.equal(credits.totnum, 1);
  });

  it('never reports a note against a purchase — that is the supplier’s sale', async () => {
    const { ctx, supplier, product } = scenario;
    const { purchase } = await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/991',
        supplierInvoiceDate: IN_PERIOD,
        items: [{ productId: product.id, quantity: 50, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'DEBIT_NOTE',
        againstPurchaseInvoiceId: purchase.id,
        reason: 'PURCHASE_RETURN',
        noteDate: IN_PERIOD,
        items: [{ invoiceItemId: purchase.items[0]!.id, quantity: 5 }],
      },
      ctxOf(),
    );

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.cdnr, undefined);
    assert.equal(json.cdnur, undefined);
    assert.equal(summary.counts.debitNotes, 0);
    assert.equal(summary.totals.taxableValue, '0.00');
  });

  it('summarises HSN by code and unit with the master description', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id, { quantity: 10 });
    await sell(customer.id, { quantity: 6 });

    const { json } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.hsn!.data.length, 1);
    const row = json.hsn!.data[0]!;
    assert.equal(row.qty, 16);
    assert.equal(row.txval, 4000);
    assert.ok(row.desc.length > 0, 'description should come from the HSN master');
  });

  it('never leaks another shop’s invoices', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id);

    const other = await createTestBusiness();
    const otherCustomer = await createTestParty(other, { displayName: 'Their customer' });
    const otherProduct = await createTestProduct(other, { name: 'Their paper' });
    await createSalesInvoice(
      other.businessId,
      other.userId,
      {
        partyId: otherCustomer.id,
        invoiceDate: IN_PERIOD,
        items: [{ productId: otherProduct.id, quantity: 99, rate: 999 }],
      },
      ctxOf(),
    );

    const { json, summary } = await buildGstr1(ctx.businessId, PERIOD);

    assert.equal(json.b2b!.length, 1);
    assert.equal(json.b2b![0]!.ctin, customer.gstin);
    assert.equal(summary.totals.taxableValue, '2500.00');
  });

  it('warns when a sale over the B2C threshold has no customer GSTIN', async () => {
    const { ctx } = scenario;
    const bigCash = await createTestParty(ctx, { displayName: 'Big cash buyer', gstin: null });
    await sell(bigCash.id, { quantity: 100, rate: 2000 });

    const { summary } = await buildGstr1(ctx.businessId, PERIOD);
    const warning = summary.warnings.find((w) => w.code === 'LARGE_SALE_WITHOUT_GSTIN');

    assert.ok(warning, 'expected a warning about a large sale without a GSTIN');
    assert.match(warning!.message, /INV\/0001/);
  });

  it('warns when freight was added to an invoice after tax', async () => {
    const { ctx, customer, product } = scenario;
    await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        invoiceDate: IN_PERIOD,
        freightCharges: '250',
        items: [{ productId: product.id, quantity: 10, rate: 250 }],
      },
      ctxOf(),
    );

    const { summary, json } = await buildGstr1(ctx.businessId, PERIOD);

    // The freight is in the invoice value the portal is told, but in no
    // section's taxable value — which is exactly what the warning is about.
    assert.equal(json.b2b![0]!.inv[0]!.val, 3050);
    assert.equal(json.b2b![0]!.inv[0]!.itms[0]!.itm_det.txval, 2500);

    const warning = summary.warnings.find((w) => w.code === 'CHARGES_OUTSIDE_TAXABLE_VALUE');
    assert.ok(warning, 'expected a warning about charges outside the taxable value');
    assert.match(warning!.message, /INV\/0001/);
  });

  it('does not warn about an unfinished month once the month is over', async () => {
    const { ctx, customer } = scenario;
    await sell(customer.id);

    const { summary } = await buildGstr1(ctx.businessId, PERIOD);
    assert.ok(!summary.warnings.some((w) => w.code === 'PERIOD_NOT_OVER'));
  });

  it('labels the period in words for the screen and MMYYYY for the portal', async () => {
    const { ctx } = scenario;
    const { summary, json } = await buildGstr1(ctx.businessId, PERIOD);
    assert.equal(summary.periodLabel, 'July 2026');
    assert.equal(json.fp, '072026');
    assert.equal(summary.gstin, (await prisma.business.findUnique({
      where: { id: ctx.businessId },
      select: { gstin: true },
    }))!.gstin);
  });
});
