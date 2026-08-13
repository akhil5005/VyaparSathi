import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';
import { D } from '../../lib/money.js';
import { buildHsnSummary } from '../invoices/tax.js';
import { formatDate, formatIndianNumber, formatPercent, formatQuantity } from './format.js';

/**
 * A4 tax invoice, rendered with pdfkit.
 *
 * Why pdfkit and not Puppeteer: a shop counter prints dozens of these a day on
 * modest hardware. Puppeteer means a ~200MB Chromium download and one to three
 * seconds of browser startup per document unless you keep one warm. pdfkit is
 * a couple of megabytes, renders in milliseconds and has no runtime beyond
 * Node. The cost is that layout is code rather than CSS — a fair trade for a
 * document whose shape is fixed by statute.
 *
 * Everything below is a legal requirement of Rule 46 of the CGST Rules unless
 * noted: the words "Tax Invoice", both parties' names/addresses/GSTINs, a
 * unique serial number and date, HSN per line, taxable value, rate and amount
 * of tax under each head, place of supply, and a signature.
 */

export interface PdfBusiness {
  legalName: string;
  tradeName?: string | null;
  gstin: string;
  stateName: string;
  stateCode: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  pincode: string;
  phone: string;
  email?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  upiId?: string | null;
  invoiceTerms?: string | null;
  invoiceFooter?: string | null;
  hsnDigits: number;
}

export interface PdfInvoiceItem {
  lineNumber: number;
  productName: string;
  description?: string | null;
  hsnCode: string;
  quantity: Prisma.Decimal;
  unitName: string;
  uqc: string;
  rate: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  cgstRate: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstRate: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstRate: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  cessRate: Prisma.Decimal;
  cessAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface PdfInvoice {
  invoiceNumber: string | null;
  invoiceDate: Date;
  dueDate?: Date | null;
  status: string;
  partyName: string;
  partyGstin?: string | null;
  partyAddress?: string | null;
  partyStateCode: string;
  partyPhone?: string | null;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  placeOfSupply: string;
  reverseCharge: boolean;
  items: PdfInvoiceItem[];
  taxableValue: Prisma.Decimal;
  totalDiscount: Prisma.Decimal;
  totalCgst: Prisma.Decimal;
  totalSgst: Prisma.Decimal;
  totalIgst: Prisma.Decimal;
  totalCess: Prisma.Decimal;
  freightCharges: Prisma.Decimal;
  otherCharges: Prisma.Decimal;
  roundOff: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  amountInWords?: string | null;
  notes?: string | null;
  transportName?: string | null;
  vehicleNumber?: string | null;
}

export interface PdfOptions {
  /**
   * Path to a TTF with the ₹ glyph (U+20B9).
   *
   * PDF's built-in Helvetica uses WinAnsi, which has no rupee sign — without an
   * embedded font the symbol renders as garbage, so amounts fall back to "Rs.".
   */
  unicodeFontPath?: string;
  /// "ORIGINAL FOR RECIPIENT", "DUPLICATE FOR TRANSPORTER", etc.
  copyLabel?: string;
  stateName?: string;
}

const PAGE_MARGIN = 36;
export const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2; // A4 width in points

/** Point size the line-item table is set in. Column widths are sized to it. */
export const LINE_FONT_SIZE = 7.5;

/**
 * Line-item column widths, in points.
 *
 * Intra-state needs two tax pairs (CGST and SGST), inter-state only one (IGST),
 * and the space that frees goes to the description.
 *
 * The numeric columns are sized against measured text, not eyeballed: at 7.5pt
 * Helvetica a lakh-scale amount ("12,34,567.89") is 44pt wide and a quantity
 * with its unit ("1000.5 Packet") is 47pt. Anything narrower wraps the figure
 * onto a second line, which on a tax invoice reads as a different number. Each
 * set sums to CONTENT_WIDTH so the right edge lands exactly on the margin.
 */
export interface LineColumns {
  sn: number;
  desc: number;
  hsn: number;
  qty: number;
  rate: number;
  taxable: number;
  /// CGST when intra-state, IGST when inter-state.
  t1: number;
  /// SGST when intra-state, unused (zero) when inter-state.
  t2: number;
  total: number;
}

export const LINE_COLUMNS: Record<'INTRA_STATE' | 'INTER_STATE', LineColumns> = {
  INTRA_STATE: { sn: 18, desc: 153, hsn: 40, qty: 52, rate: 50, taxable: 52, t1: 54, t2: 54, total: 50 },
  INTER_STATE: { sn: 18, desc: 205, hsn: 40, qty: 52, rate: 50, taxable: 52, t1: 56, t2: 0, total: 50 },
};

/// Padding taken out of each cell, so usable width is `column - CELL_PADDING`.
export const CELL_PADDING = 4;

/** Renders the invoice and resolves with the finished PDF bytes. */
export function renderInvoicePdf(
  business: PdfBusiness,
  invoice: PdfInvoice,
  options: PdfOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let regular = 'Helvetica';
    let bold = 'Helvetica-Bold';
    let currency = 'Rs.';

    if (options.unicodeFontPath && fs.existsSync(options.unicodeFontPath)) {
      doc.registerFont('body', options.unicodeFontPath);
      regular = 'body';
      bold = 'body';
      currency = '₹';
    }

    const money = (value: Prisma.Decimal.Value) => formatIndianNumber(value);
    const intraState = invoice.supplyType === 'INTRA_STATE';

    // ---- Title bar ----
    doc.font(bold).fontSize(16).text('TAX INVOICE', { align: 'center' });
    if (options.copyLabel) {
      doc.font(regular).fontSize(8).text(options.copyLabel, { align: 'center' });
    }
    if (invoice.status === 'CANCELLED') {
      doc.font(bold).fontSize(12).fillColor('red').text('CANCELLED', { align: 'center' });
      doc.fillColor('black');
    }
    doc.moveDown(0.5);

    const boxTop = doc.y;

    // ---- Supplier ----
    doc.font(bold).fontSize(12).text(business.tradeName || business.legalName, PAGE_MARGIN, doc.y);
    doc.font(regular).fontSize(9);
    if (business.tradeName && business.tradeName !== business.legalName) {
      doc.text(business.legalName);
    }
    doc.text(
      [business.addressLine1, business.addressLine2, `${business.city} - ${business.pincode}`]
        .filter(Boolean)
        .join(', '),
      { width: CONTENT_WIDTH * 0.55 },
    );
    doc.text(`Phone: ${business.phone}${business.email ? ` | ${business.email}` : ''}`);
    doc.font(bold).text(`GSTIN: ${business.gstin}`);
    doc.font(regular).text(`State: ${business.stateName} (${business.stateCode})`);

    // ---- Document meta, right column ----
    const metaX = PAGE_MARGIN + CONTENT_WIDTH * 0.6;
    let metaY = boxTop;
    const meta = (label: string, value: string) => {
      doc.font(regular).fontSize(9).text(`${label}:`, metaX, metaY, { width: 90, continued: false });
      doc.font(bold).text(value, metaX + 95, metaY, { width: CONTENT_WIDTH * 0.4 - 95 });
      metaY += 13;
    };
    meta('Invoice No', invoice.invoiceNumber ?? 'DRAFT');
    meta('Date', formatDate(invoice.invoiceDate));
    if (invoice.dueDate) meta('Due Date', formatDate(invoice.dueDate));
    meta('Place of Supply', `${options.stateName ?? ''} (${invoice.placeOfSupply})`.trim());
    if (invoice.reverseCharge) meta('Reverse Charge', 'YES');

    doc.y = Math.max(doc.y, metaY) + 8;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).stroke();
    doc.moveDown(0.5);

    // ---- Recipient ----
    doc.font(bold).fontSize(9).text('Bill To', PAGE_MARGIN, doc.y);
    doc.font(bold).fontSize(11).text(invoice.partyName);
    doc.font(regular).fontSize(9);
    if (invoice.partyAddress) doc.text(invoice.partyAddress, { width: CONTENT_WIDTH * 0.6 });
    if (invoice.partyPhone) doc.text(`Phone: ${invoice.partyPhone}`);
    doc.text(
      invoice.partyGstin
        ? `GSTIN: ${invoice.partyGstin}`
        : 'GSTIN: Unregistered', // B2C — still required to be shown as such
    );
    doc.moveDown(0.5);

    // ---- Line items ----
    const cols = intraState ? LINE_COLUMNS.INTRA_STATE : LINE_COLUMNS.INTER_STATE;

    const x = {
      sn: PAGE_MARGIN,
      desc: PAGE_MARGIN + cols.sn,
      hsn: PAGE_MARGIN + cols.sn + cols.desc,
      qty: PAGE_MARGIN + cols.sn + cols.desc + cols.hsn,
      rate: PAGE_MARGIN + cols.sn + cols.desc + cols.hsn + cols.qty,
      taxable: PAGE_MARGIN + cols.sn + cols.desc + cols.hsn + cols.qty + cols.rate,
      t1: PAGE_MARGIN + cols.sn + cols.desc + cols.hsn + cols.qty + cols.rate + cols.taxable,
      t2:
        PAGE_MARGIN + cols.sn + cols.desc + cols.hsn + cols.qty + cols.rate + cols.taxable + cols.t1,
      total:
        PAGE_MARGIN +
        cols.sn +
        cols.desc +
        cols.hsn +
        cols.qty +
        cols.rate +
        cols.taxable +
        cols.t1 +
        cols.t2,
    };

    const headerY = doc.y;
    doc.rect(PAGE_MARGIN, headerY, CONTENT_WIDTH, 16).fill('#eeeeee');
    doc.fillColor('black').font(bold).fontSize(LINE_FONT_SIZE);

    const head = (text: string, left: number, width: number, align: 'left' | 'right' = 'left') =>
      doc.text(text, left + 2, headerY + 5, { width: width - 4, align });

    head('#', x.sn, cols.sn);
    head('Description', x.desc, cols.desc);
    head('HSN', x.hsn, cols.hsn);
    head('Qty', x.qty, cols.qty, 'right');
    head('Rate', x.rate, cols.rate, 'right');
    head('Taxable', x.taxable, cols.taxable, 'right');
    if (intraState) {
      head('CGST', x.t1, cols.t1, 'right');
      head('SGST', x.t2, cols.t2, 'right');
    } else {
      head('IGST', x.t1, cols.t1, 'right');
    }
    head('Total', x.total, cols.total, 'right');

    doc.y = headerY + 16;
    doc.font(regular).fontSize(LINE_FONT_SIZE);

    for (const item of invoice.items) {
      // A tall row near the page break would otherwise be split down the middle.
      if (doc.y > 700) {
        doc.addPage();
        doc.y = PAGE_MARGIN;
      }

      const rowY = doc.y;
      const cell = (text: string, left: number, width: number, align: 'left' | 'right' = 'left') =>
        doc.text(text, left + 2, rowY + 3, { width: width - 4, align });

      cell(String(item.lineNumber), x.sn, cols.sn);
      doc.text(item.productName, x.desc + 2, rowY + 3, { width: cols.desc - 4 });
      const descBottom = doc.y;

      cell(item.hsnCode, x.hsn, cols.hsn);
      cell(`${formatQuantity(item.quantity)} ${item.unitName}`, x.qty, cols.qty, 'right');
      cell(money(item.rate), x.rate, cols.rate, 'right');
      cell(money(item.taxableValue), x.taxable, cols.taxable, 'right');

      if (intraState) {
        cell(`${formatPercent(item.cgstRate)}\n${money(item.cgstAmount)}`, x.t1, cols.t1, 'right');
        cell(`${formatPercent(item.sgstRate)}\n${money(item.sgstAmount)}`, x.t2, cols.t2, 'right');
      } else {
        cell(`${formatPercent(item.igstRate)}\n${money(item.igstAmount)}`, x.t1, cols.t1, 'right');
      }
      cell(money(item.lineTotal), x.total, cols.total, 'right');

      const rowBottom = Math.max(descBottom, rowY + 20);
      doc
        .moveTo(PAGE_MARGIN, rowBottom)
        .lineTo(PAGE_MARGIN + CONTENT_WIDTH, rowBottom)
        .strokeColor('#cccccc')
        .stroke()
        .strokeColor('black');
      doc.y = rowBottom + 2;
    }

    doc.moveDown(0.5);

    // ---- Totals block, right-aligned ----
    const totalsX = PAGE_MARGIN + CONTENT_WIDTH - 220;
    const totalsY = doc.y;
    let ty = totalsY;

    const totalRow = (label: string, value: string, emphasise = false) => {
      doc.font(emphasise ? bold : regular).fontSize(emphasise ? 10 : 9);
      doc.text(label, totalsX, ty, { width: 120 });
      doc.text(value, totalsX + 120, ty, { width: 100, align: 'right' });
      ty += emphasise ? 16 : 13;
    };

    totalRow('Taxable Value', money(invoice.taxableValue));
    if (!D(invoice.totalDiscount).isZero()) {
      totalRow('Discount', money(invoice.totalDiscount));
    }
    if (intraState) {
      totalRow('CGST', money(invoice.totalCgst));
      totalRow('SGST', money(invoice.totalSgst));
    } else {
      totalRow('IGST', money(invoice.totalIgst));
    }
    if (!D(invoice.totalCess).isZero()) totalRow('Cess', money(invoice.totalCess));
    if (!D(invoice.freightCharges).isZero()) totalRow('Freight', money(invoice.freightCharges));
    if (!D(invoice.otherCharges).isZero()) totalRow('Other Charges', money(invoice.otherCharges));
    if (!D(invoice.roundOff).isZero()) totalRow('Round Off', money(invoice.roundOff));

    doc.moveTo(totalsX, ty).lineTo(PAGE_MARGIN + CONTENT_WIDTH, ty).stroke();
    ty += 4;
    totalRow('TOTAL', `${currency} ${money(invoice.grandTotal)}`, true);

    // ---- Amount in words, left of the totals ----
    if (invoice.amountInWords) {
      doc.font(regular).fontSize(9).text('Amount in words:', PAGE_MARGIN, totalsY, { width: 300 });
      doc.font(bold).fontSize(9).text(invoice.amountInWords, PAGE_MARGIN, totalsY + 13, {
        width: CONTENT_WIDTH - 240,
      });
    }

    doc.y = Math.max(doc.y, ty) + 10;

    // ---- HSN summary ----
    // Required on the invoice above the turnover threshold, and the figures the
    // GSTR-1 filing needs, so it is always printed.
    const summary = buildHsnSummary(
      invoice.items.map((item) => ({
        hsnCode: item.hsnCode,
        uqc: item.uqc,
        quantity: D(item.quantity),
        grossAmount: D(item.taxableValue).plus(D(item.discountAmount)),
        discountAmount: D(item.discountAmount),
        discountPercent: D(item.discountPercent),
        taxableValue: D(item.taxableValue),
        cgstRate: D(item.cgstRate),
        cgstAmount: D(item.cgstAmount),
        sgstRate: D(item.sgstRate),
        sgstAmount: D(item.sgstAmount),
        igstRate: D(item.igstRate),
        igstAmount: D(item.igstAmount),
        cessRate: D(item.cessRate),
        cessAmount: D(item.cessAmount),
        lineTotal: D(item.lineTotal),
      })),
    );

    if (doc.y > 640) doc.addPage();

    doc.font(bold).fontSize(8).text('HSN Summary', PAGE_MARGIN, doc.y);
    const sumY = doc.y + 2;
    doc.rect(PAGE_MARGIN, sumY, CONTENT_WIDTH, 14).fill('#eeeeee');
    doc.fillColor('black').font(bold).fontSize(7);

    const sumCols = [90, 50, 70, 90, 90, 90];
    const sumX = sumCols.reduce<number[]>((acc, width, i) => {
      acc.push(i === 0 ? PAGE_MARGIN : acc[i - 1]! + sumCols[i - 1]!);
      return acc;
    }, []);
    const sumHeads = intraState
      ? ['HSN', 'UQC', 'Qty', 'Taxable', 'CGST', 'SGST']
      : ['HSN', 'UQC', 'Qty', 'Taxable', 'IGST', 'Cess'];
    sumHeads.forEach((label, i) =>
      doc.text(label, sumX[i]! + 2, sumY + 4, {
        width: sumCols[i]! - 4,
        align: i >= 2 ? 'right' : 'left',
      }),
    );

    doc.y = sumY + 14;
    doc.font(regular).fontSize(7);
    for (const row of summary) {
      const rowY = doc.y;
      const values = intraState
        ? [
            row.hsnCode,
            row.uqc,
            formatQuantity(row.quantity),
            money(row.taxableValue),
            money(row.cgstAmount),
            money(row.sgstAmount),
          ]
        : [
            row.hsnCode,
            row.uqc,
            formatQuantity(row.quantity),
            money(row.taxableValue),
            money(row.igstAmount),
            money(row.cessAmount),
          ];
      values.forEach((value, i) =>
        doc.text(value, sumX[i]! + 2, rowY + 2, {
          width: sumCols[i]! - 4,
          align: i >= 2 ? 'right' : 'left',
        }),
      );
      doc.y = rowY + 11;
    }

    doc.moveDown(1);

    // ---- Bank details, terms, signature ----
    const footerY = doc.y;
    if (business.bankName || business.upiId) {
      doc.font(bold).fontSize(8).text('Bank Details', PAGE_MARGIN, footerY);
      doc.font(regular).fontSize(8);
      if (business.bankName) doc.text(`Bank: ${business.bankName}`);
      if (business.bankAccountNumber) doc.text(`A/c: ${business.bankAccountNumber}`);
      if (business.bankIfsc) doc.text(`IFSC: ${business.bankIfsc}`);
      if (business.upiId) doc.text(`UPI: ${business.upiId}`);
    }

    if (invoice.transportName || invoice.vehicleNumber) {
      doc.font(regular).fontSize(8);
      doc.text(
        `Transport: ${invoice.transportName ?? '-'}  Vehicle: ${invoice.vehicleNumber ?? '-'}`,
      );
    }

    if (business.invoiceTerms) {
      doc.moveDown(0.5);
      doc.font(bold).fontSize(8).text('Terms & Conditions');
      doc.font(regular).fontSize(7).text(business.invoiceTerms, { width: CONTENT_WIDTH * 0.55 });
    }

    const signY = Math.max(doc.y, footerY + 60);
    doc
      .font(regular)
      .fontSize(8)
      .text(`For ${business.tradeName || business.legalName}`, PAGE_MARGIN + CONTENT_WIDTH - 200, signY, {
        width: 200,
        align: 'right',
      });
    doc.text('Authorised Signatory', PAGE_MARGIN + CONTENT_WIDTH - 200, signY + 40, {
      width: 200,
      align: 'right',
    });

    if (business.invoiceFooter) {
      doc.font(regular).fontSize(7).text(business.invoiceFooter, PAGE_MARGIN, signY + 60, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    }

    doc.end();
  });
}
