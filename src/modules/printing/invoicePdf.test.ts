import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';
import {
  CELL_PADDING,
  CONTENT_WIDTH,
  LINE_COLUMNS,
  LINE_FONT_SIZE,
  renderInvoicePdf,
  type PdfBusiness,
  type PdfInvoice,
  type PdfInvoiceItem,
} from './invoicePdf.js';

/**
 * A PDF's bytes are compressed, so there is no honest way to assert "the total
 * appears in the top right" without rasterising and diffing images — which is a
 * whole test infrastructure for a document whose layout a human will eyeball
 * once. What these tests do assert is that every branch of the layout code runs
 * to completion and produces a structurally valid PDF, which is what actually
 * breaks: a stray undefined in a `doc.text` call throws, and a page-break bug
 * loops forever.
 */

const d = (v: string | number) => new Prisma.Decimal(v);

const business: PdfBusiness = {
  legalName: 'Mittal Paper Traders',
  tradeName: 'Mittal Paper House',
  gstin: '03AABCM1234C1ZX',
  stateName: 'Punjab',
  stateCode: '03',
  addressLine1: 'Shop 14, Paper Market',
  addressLine2: 'Gill Road',
  city: 'Ludhiana',
  pincode: '141008',
  phone: '9876543210',
  email: 'sales@mittalpaper.in',
  bankName: 'Punjab National Bank',
  bankAccountNumber: '1234567890',
  bankIfsc: 'PUNB0123456',
  upiId: 'mittalpaper@upi',
  invoiceTerms: 'Payment within 30 days. Interest at 18% p.a. on overdue amounts.',
  invoiceFooter: 'Subject to Ludhiana jurisdiction',
  hsnDigits: 4,
};

const item = (overrides: Partial<PdfInvoiceItem> = {}): PdfInvoiceItem => ({
  lineNumber: 1,
  productName: 'A4 Copier Paper 75gsm',
  description: null,
  hsnCode: '4802',
  quantity: d(10),
  unitName: 'Ream',
  uqc: 'REA',
  rate: d(240),
  discountAmount: d(0),
  discountPercent: d(0),
  taxableValue: d(2400),
  cgstRate: d(6),
  cgstAmount: d(144),
  sgstRate: d(6),
  sgstAmount: d(144),
  igstRate: d(0),
  igstAmount: d(0),
  cessRate: d(0),
  cessAmount: d(0),
  lineTotal: d(2688),
  ...overrides,
});

const invoice = (overrides: Partial<PdfInvoice> = {}): PdfInvoice => ({
  invoiceNumber: 'INV/2026-27/0001',
  invoiceDate: new Date(2026, 3, 9),
  dueDate: new Date(2026, 4, 9),
  status: 'ISSUED',
  partyName: 'Sharma Stationery',
  partyGstin: '03AACCS5678D1Z9',
  partyAddress: 'Chaura Bazar, Ludhiana, Punjab - 141008',
  partyStateCode: '03',
  partyPhone: '9812345678',
  supplyType: 'INTRA_STATE',
  placeOfSupply: '03',
  reverseCharge: false,
  items: [item()],
  taxableValue: d(2400),
  totalDiscount: d(0),
  totalCgst: d(144),
  totalSgst: d(144),
  totalIgst: d(0),
  totalCess: d(0),
  freightCharges: d(0),
  otherCharges: d(0),
  roundOff: d(0),
  grandTotal: d(2688),
  amountInWords: 'Rupees Two Thousand Six Hundred Eighty Eight Only',
  notes: null,
  transportName: null,
  vehicleNumber: null,
  ...overrides,
});

/** A PDF starts with %PDF- and ends with %%EOF; anything else won't open. */
function assertValidPdf(buffer: Buffer) {
  assert.ok(buffer.length > 1000, `only ${buffer.length} bytes — the render bailed early`);
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buffer.subarray(-1024).toString('latin1').includes('%%EOF'), 'missing trailer');
}

describe('line-item column widths', () => {
  /** Measures real Helvetica glyph widths at the size the table is set in. */
  const measure = (text: string, bold = false) => {
    const doc = new PDFDocument({ size: 'A4' });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(LINE_FONT_SIZE);
    const width = doc.widthOfString(text);
    doc.end();
    return width;
  };

  for (const [supplyType, cols] of Object.entries(LINE_COLUMNS)) {
    const total = Object.values(cols).reduce((sum, w) => sum + w, 0);

    it(`${supplyType} columns fill the content width exactly`, () => {
      // Short and the right edge floats off the margin; long and the last
      // column runs off the page.
      assert.ok(
        Math.abs(total - CONTENT_WIDTH) < 1,
        `columns sum to ${total}, content width is ${CONTENT_WIDTH}`,
      );
    });

    it(`${supplyType} numeric columns fit a lakh-scale figure without wrapping`, () => {
      // A wrapped amount on a tax invoice reads as a different number, so this
      // is a correctness constraint, not a cosmetic one.
      const worstAmount = measure('12,34,567.89');
      for (const key of ['rate', 'taxable', 'total'] as const) {
        assert.ok(
          cols[key] - CELL_PADDING >= worstAmount,
          `${supplyType}.${key} is ${cols[key]}pt; needs ${(worstAmount + CELL_PADDING).toFixed(1)}pt`,
        );
      }
    });

    it(`${supplyType} qty column fits a quantity with its unit name`, () => {
      const worstQty = measure('1000.5 Packet');
      assert.ok(cols.qty - CELL_PADDING >= worstQty, `qty is ${cols.qty}pt, needs ${worstQty.toFixed(1)}pt`);
    });

    it(`${supplyType} hsn column fits an 8-digit HSN`, () => {
      assert.ok(cols.hsn - CELL_PADDING >= measure('48025500'));
    });

    it(`${supplyType} headers fit their columns`, () => {
      const headers: [keyof typeof cols, string][] = [
        ['desc', 'Description'],
        ['hsn', 'HSN'],
        ['qty', 'Qty'],
        ['rate', 'Rate'],
        ['taxable', 'Taxable'],
        ['total', 'Total'],
      ];
      for (const [key, label] of headers) {
        assert.ok(
          cols[key] - CELL_PADDING >= measure(label, true),
          `header "${label}" does not fit ${supplyType}.${key}`,
        );
      }
    });
  }
});

describe('renderInvoicePdf', () => {
  it('renders a local (CGST + SGST) invoice', async () => {
    assertValidPdf(await renderInvoicePdf(business, invoice()));
  });

  it('renders an interstate (IGST) invoice, which uses different columns', async () => {
    const pdf = await renderInvoicePdf(
      business,
      invoice({
        supplyType: 'INTER_STATE',
        placeOfSupply: '06',
        partyStateCode: '06',
        items: [item({ cgstRate: d(0), cgstAmount: d(0), sgstRate: d(0), sgstAmount: d(0), igstRate: d(12), igstAmount: d(288) })],
        totalCgst: d(0),
        totalSgst: d(0),
        totalIgst: d(288),
      }),
      { stateName: 'Haryana' },
    );
    assertValidPdf(pdf);
  });

  it('renders a draft with no invoice number', async () => {
    assertValidPdf(await renderInvoicePdf(business, invoice({ invoiceNumber: null, status: 'DRAFT', dueDate: null })));
  });

  it('renders a cancelled invoice with its watermark', async () => {
    assertValidPdf(await renderInvoicePdf(business, invoice({ status: 'CANCELLED' })));
  });

  it('renders a B2C invoice with no customer GSTIN', async () => {
    assertValidPdf(
      await renderInvoicePdf(business, invoice({ partyGstin: null, partyAddress: null, partyPhone: null })),
    );
  });

  it('renders every optional total: discount, cess, freight, other, round off', async () => {
    assertValidPdf(
      await renderInvoicePdf(
        business,
        invoice({
          items: [item({ discountPercent: d(5), discountAmount: d(120), taxableValue: d(2280), cessRate: d(1), cessAmount: d('22.80') })],
          totalDiscount: d(120),
          totalCess: d('22.80'),
          freightCharges: d(150),
          otherCharges: d(50),
          roundOff: d('-0.40'),
          grandTotal: d(2776),
          reverseCharge: true,
          transportName: 'Punjab Roadways',
          vehicleNumber: 'PB10AB1234',
        }),
      ),
    );
  });

  it('renders a bare business with no bank, terms or footer', async () => {
    const minimal: PdfBusiness = {
      ...business,
      tradeName: null,
      addressLine2: null,
      email: null,
      bankName: null,
      bankAccountNumber: null,
      bankIfsc: null,
      upiId: null,
      invoiceTerms: null,
      invoiceFooter: null,
    };
    assertValidPdf(await renderInvoicePdf(minimal, invoice()));
  });

  it('paginates a long invoice rather than overflowing one page', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ lineNumber: i + 1, productName: `Product line ${i + 1} — a deliberately long description` }),
    );
    const long = await renderInvoicePdf(business, invoice({ items: many }));
    assertValidPdf(long);
    assert.ok(long.length > (await renderInvoicePdf(business, invoice())).length);
  });

  it('adds the copy label when one is requested', async () => {
    assertValidPdf(
      await renderInvoicePdf(business, invoice(), { copyLabel: 'ORIGINAL FOR RECIPIENT' }),
    );
  });

  it('ignores a font path that does not exist rather than throwing', async () => {
    // Falls back to Helvetica and "Rs." — a missing font must not stop a bill.
    assertValidPdf(
      await renderInvoicePdf(business, invoice(), { unicodeFontPath: '/no/such/font.ttf' }),
    );
  });
});
