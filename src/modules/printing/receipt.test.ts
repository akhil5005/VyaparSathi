import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { buildReceiptLines, renderReceipt, type ReceiptBusiness, type ReceiptInvoice } from './receipt.js';

const d = (v: string | number) => new Prisma.Decimal(v);

const business: ReceiptBusiness = {
  legalName: 'Mittal Paper Traders',
  tradeName: 'Mittal Paper House',
  gstin: '03AABCM1234C1ZX',
  addressLine1: 'Shop 14, Paper Market',
  addressLine2: null,
  city: 'Ludhiana',
  pincode: '141008',
  phone: '9876543210',
  invoiceFooter: 'Goods once sold will not be taken back',
};

/** 10 reams at 240, 12% GST split as 6+6 — the shop's typical bill. */
const intraStateInvoice = (): ReceiptInvoice => ({
  invoiceNumber: 'INV/2026-27/0001',
  invoiceDate: new Date(2026, 3, 9),
  partyName: 'Sharma Stationery',
  partyGstin: '03AACCS5678D1Z9',
  partyPhone: '9812345678',
  supplyType: 'INTRA_STATE',
  items: [
    {
      productName: 'A4 Copier Paper 75gsm',
      quantity: d(10),
      unitName: 'Ream',
      rate: d(240),
      taxableValue: d(2400),
      cgstRate: d(6),
      sgstRate: d(6),
      igstRate: d(0),
      lineTotal: d(2688),
    },
  ],
  taxableValue: d(2400),
  totalCgst: d(144),
  totalSgst: d(144),
  totalIgst: d(0),
  totalCess: d(0),
  freightCharges: d(0),
  otherCharges: d(0),
  roundOff: d(0),
  grandTotal: d(2688),
  amountInWords: 'Rupees Two Thousand Six Hundred Eighty Eight Only',
  amountPaid: d(1000),
});

describe('buildReceiptLines', () => {
  it('never exceeds the roll width, at either size', () => {
    for (const width of [32, 48]) {
      for (const line of buildReceiptLines(business, intraStateInvoice(), { width })) {
        assert.ok(line.length <= width, `"${line}" is ${line.length} chars on a ${width} roll`);
      }
    }
  });

  it('carries everything a customer needs to identify the bill', () => {
    const text = buildReceiptLines(business, intraStateInvoice(), { width: 32 }).join('\n');

    assert.ok(text.includes('Mittal Paper House'), 'trade name');
    assert.ok(text.includes('03AABCM1234C1ZX'), 'supplier GSTIN');
    assert.ok(text.includes('TAX INVOICE'));
    assert.ok(text.includes('INV/2026-27/0001'), 'invoice number');
    assert.ok(text.includes('09/04/2026'), 'invoice date');
    assert.ok(text.includes('Sharma Stationery'), 'customer');
    assert.ok(text.includes('03AACCS5678D1Z9'), 'customer GSTIN');
    assert.ok(text.includes('2,688.00'), 'grand total');
  });

  it('shows CGST and SGST with their rates for a local sale', () => {
    const text = buildReceiptLines(business, intraStateInvoice(), { width: 32 }).join('\n');
    assert.ok(text.includes('CGST 6%'));
    assert.ok(text.includes('SGST 6%'));
    assert.ok(!text.includes('IGST'));
  });

  it('shows IGST alone for a sale outside Punjab', () => {
    const invoice = intraStateInvoice();
    invoice.supplyType = 'INTER_STATE';
    invoice.items[0]!.cgstRate = d(0);
    invoice.items[0]!.sgstRate = d(0);
    invoice.items[0]!.igstRate = d(12);
    invoice.totalCgst = d(0);
    invoice.totalSgst = d(0);
    invoice.totalIgst = d(288);

    const text = buildReceiptLines(business, invoice, { width: 32 }).join('\n');
    assert.ok(text.includes('IGST 12%'));
    assert.ok(!text.includes('CGST'));
    assert.ok(!text.includes('SGST'));
  });

  it('omits zero freight, cess, other charges and round off', () => {
    const text = buildReceiptLines(business, intraStateInvoice(), { width: 32 }).join('\n');
    for (const label of ['Cess', 'Freight', 'Other', 'Round Off']) {
      assert.ok(!text.includes(label), `${label} should not print when zero`);
    }
  });

  it('prints a round off when there is one', () => {
    const invoice = intraStateInvoice();
    invoice.roundOff = d('-0.40');
    const text = buildReceiptLines(business, invoice, { width: 32 }).join('\n');
    assert.ok(text.includes('Round Off'));
    assert.ok(text.includes('-0.40'));
  });

  it('shows the balance due only when asked', () => {
    const invoice = intraStateInvoice();
    const without = buildReceiptLines(business, invoice, { width: 32 }).join('\n');
    assert.ok(!without.includes('Balance Due'));

    const withBalance = buildReceiptLines(business, invoice, {
      width: 32,
      showBalance: true,
    }).join('\n');
    assert.ok(withBalance.includes('Balance Due'));
    // 2688 billed, 1000 paid.
    assert.ok(withBalance.includes('1,688.00'));
  });

  it('labels a DRAFT that has no number yet', () => {
    const invoice = intraStateInvoice();
    invoice.invoiceNumber = null;
    assert.ok(buildReceiptLines(business, invoice, { width: 32 }).join('\n').includes('DRAFT'));
  });

  it('wraps a long product name instead of truncating it', () => {
    const invoice = intraStateInvoice();
    invoice.items[0]!.productName = 'JK Excel Bond Premium A4 Copier Paper 75gsm Bright White';
    const lines = buildReceiptLines(business, invoice, { width: 32 });
    const text = lines.join(' ');

    assert.ok(text.includes('JK Excel Bond Premium'));
    assert.ok(text.includes('Bright White'));
    for (const line of lines) assert.ok(line.length <= 32);
  });

  it('includes the copy label when one is given', () => {
    const lines = buildReceiptLines(business, intraStateInvoice(), {
      width: 32,
      copyLabel: 'DUPLICATE',
    });
    assert.ok(lines.join('\n').includes('(DUPLICATE)'));
  });
});

describe('renderReceipt', () => {
  it('starts with a reset', () => {
    const buffer = renderReceipt(['Hello']);
    assert.deepEqual([...buffer.subarray(0, 2)], [0x1b, 0x40]);
  });

  it('emphasises the title and the total, and nothing else', () => {
    const buffer = renderReceipt(['   TAX INVOICE', 'Taxable      2,400.00', 'TOTAL   2,688.00']);
    const boldOn = [...buffer].filter((_, i) => buffer[i] === 0x1b && buffer[i + 1] === 0x45 && buffer[i + 2] === 1);
    assert.equal(boldOn.length, 2);
  });

  it('cuts by default and feeds instead when told not to', () => {
    const withCut = renderReceipt(['x']);
    assert.ok(withCut.includes(Buffer.from([0x1d, 0x56, 66, 0])));

    const withoutCut = renderReceipt(['x'], { cutAfterPrint: false });
    assert.ok(!withoutCut.includes(Buffer.from([0x1d, 0x56, 66, 0])));
  });

  it('repeats the whole receipt per copy, resetting each time', () => {
    const buffer = renderReceipt(['x'], { copies: 2 });
    let resets = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x1b && buffer[i + 1] === 0x40) resets++;
    }
    assert.equal(resets, 2);
  });

  it('kicks the drawer once, not once per copy', () => {
    const buffer = renderReceipt(['x'], { copies: 3, openCashDrawer: true });
    let kicks = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x1b && buffer[i + 1] === 0x70) kicks++;
    }
    assert.equal(kicks, 1);
  });

  it('selects the code page when the profile names one', () => {
    assert.ok(renderReceipt(['x'], { codePage: 16 }).includes(Buffer.from([0x1b, 0x74, 16])));
  });
});
