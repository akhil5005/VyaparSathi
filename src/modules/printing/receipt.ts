import { Prisma } from '@prisma/client';
import { D } from '../../lib/money.js';
import { EscPosBuilder } from './escpos.js';
import {
  centre,
  columns,
  divider,
  formatDate,
  formatIndianNumber,
  formatPercent,
  formatQuantity,
  labelValue,
  wrap,
} from './format.js';

/**
 * Thermal receipt layout.
 *
 * Split deliberately in two: `buildReceiptLines` produces plain strings, which
 * can be asserted in a test and shown on screen as a print preview, and
 * `renderReceipt` wraps those lines in ESC/POS bytes. Testing byte buffers for
 * layout mistakes is miserable; testing strings is not.
 */

export interface ReceiptBusiness {
  legalName: string;
  tradeName?: string | null;
  gstin: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  pincode: string;
  phone: string;
  invoiceFooter?: string | null;
}

export interface ReceiptItem {
  productName: string;
  quantity: Prisma.Decimal;
  unitName: string;
  rate: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  cgstRate: Prisma.Decimal;
  sgstRate: Prisma.Decimal;
  igstRate: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface ReceiptInvoice {
  invoiceNumber: string | null;
  invoiceDate: Date;
  partyName: string;
  partyGstin?: string | null;
  partyPhone?: string | null;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  items: ReceiptItem[];
  taxableValue: Prisma.Decimal;
  totalCgst: Prisma.Decimal;
  totalSgst: Prisma.Decimal;
  totalIgst: Prisma.Decimal;
  totalCess: Prisma.Decimal;
  freightCharges: Prisma.Decimal;
  otherCharges: Prisma.Decimal;
  roundOff: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  amountInWords?: string | null;
  amountPaid?: Prisma.Decimal;
}

export interface ReceiptOptions {
  width: number;
  /// Printed under the total so the customer sees what is still owed.
  showBalance?: boolean;
  copyLabel?: string;
}

/**
 * The receipt as plain text lines, each exactly `width` characters or shorter.
 */
export function buildReceiptLines(
  business: ReceiptBusiness,
  invoice: ReceiptInvoice,
  options: ReceiptOptions,
): string[] {
  const w = options.width;
  const out: string[] = [];
  const rule = () => out.push(divider(w));

  // ---- Header ----
  out.push(centre(business.tradeName || business.legalName, w));
  for (const line of wrap(
    [business.addressLine1, business.addressLine2, business.city, business.pincode]
      .filter(Boolean)
      .join(', '),
    w,
  )) {
    out.push(centre(line, w));
  }
  out.push(centre(`Ph: ${business.phone}`, w));
  out.push(centre(`GSTIN: ${business.gstin}`, w));
  rule();
  out.push(centre('TAX INVOICE', w));
  if (options.copyLabel) out.push(centre(`(${options.copyLabel})`, w));
  rule();

  // ---- Document and party ----
  out.push(labelValue(`No: ${invoice.invoiceNumber ?? 'DRAFT'}`, formatDate(invoice.invoiceDate), w));
  for (const line of wrap(`To: ${invoice.partyName}`, w)) out.push(line);
  if (invoice.partyGstin) out.push(`GSTIN: ${invoice.partyGstin}`);
  if (invoice.partyPhone) out.push(`Ph: ${invoice.partyPhone}`);
  rule();

  // ---- Items ----
  // The name gets its own line and the figures the next, which is the only
  // layout that survives a 32-character roll without truncating product names
  // into uselessness.
  out.push(
    columns(
      [
        { text: 'Qty x Rate', width: w - 12 },
        { text: 'Amount', width: 12, align: 'right' },
      ],
      w,
    ),
  );
  rule();

  for (const item of invoice.items) {
    for (const line of wrap(item.productName, w)) out.push(line);

    const qtyRate = `${formatQuantity(item.quantity)} ${item.unitName} x ${formatIndianNumber(item.rate)}`;
    out.push(
      columns(
        [
          { text: `  ${qtyRate}`, width: w - 12 },
          { text: formatIndianNumber(item.taxableValue), width: 12, align: 'right' },
        ],
        w,
      ),
    );
  }

  rule();

  // ---- Totals ----
  out.push(labelValue('Taxable', formatIndianNumber(invoice.taxableValue), w));

  if (invoice.supplyType === 'INTRA_STATE') {
    const half = invoice.items[0];
    const cgstLabel = half ? `CGST ${formatPercent(half.cgstRate)}` : 'CGST';
    const sgstLabel = half ? `SGST ${formatPercent(half.sgstRate)}` : 'SGST';
    out.push(labelValue(cgstLabel, formatIndianNumber(invoice.totalCgst), w));
    out.push(labelValue(sgstLabel, formatIndianNumber(invoice.totalSgst), w));
  } else {
    const first = invoice.items[0];
    const igstLabel = first ? `IGST ${formatPercent(first.igstRate)}` : 'IGST';
    out.push(labelValue(igstLabel, formatIndianNumber(invoice.totalIgst), w));
  }

  if (!D(invoice.totalCess).isZero()) {
    out.push(labelValue('Cess', formatIndianNumber(invoice.totalCess), w));
  }
  if (!D(invoice.freightCharges).isZero()) {
    out.push(labelValue('Freight', formatIndianNumber(invoice.freightCharges), w));
  }
  if (!D(invoice.otherCharges).isZero()) {
    out.push(labelValue('Other', formatIndianNumber(invoice.otherCharges), w));
  }
  if (!D(invoice.roundOff).isZero()) {
    out.push(labelValue('Round Off', formatIndianNumber(invoice.roundOff), w));
  }

  rule();
  out.push(labelValue('TOTAL', formatIndianNumber(invoice.grandTotal), w));
  rule();

  if (invoice.amountInWords) {
    for (const line of wrap(invoice.amountInWords, w)) out.push(line);
    rule();
  }

  if (options.showBalance && invoice.amountPaid !== undefined) {
    const due = D(invoice.grandTotal).minus(D(invoice.amountPaid));
    out.push(labelValue('Paid', formatIndianNumber(invoice.amountPaid), w));
    out.push(labelValue('Balance Due', formatIndianNumber(due), w));
    rule();
  }

  // ---- Footer ----
  if (business.invoiceFooter) {
    for (const line of wrap(business.invoiceFooter, w)) out.push(centre(line, w));
  }
  out.push(centre('Thank you', w));

  return out;
}

export interface RenderOptions {
  codePage?: number;
  cutAfterPrint?: boolean;
  openCashDrawer?: boolean;
  copies?: number;
}

/** Wraps the text layout in ESC/POS, with the header and total emphasised. */
export function renderReceipt(lines: string[], options: RenderOptions = {}): Buffer {
  const builder = new EscPosBuilder();
  const copies = Math.max(1, options.copies ?? 1);

  for (let copy = 0; copy < copies; copy++) {
    builder.initialise();
    if (options.codePage !== undefined) builder.codePage(options.codePage);

    builder.align('left');

    for (const line of lines) {
      const trimmed = line.trim();
      // The shop name and the grand total are the two things read from across
      // a counter, so they get the emphasis.
      const emphasise = trimmed === 'TAX INVOICE' || trimmed.startsWith('TOTAL');
      if (emphasise) builder.bold(true);
      builder.line(line);
      if (emphasise) builder.bold(false);
    }

    if (options.openCashDrawer && copy === 0) builder.openCashDrawer();
    if (options.cutAfterPrint !== false) builder.cut();
    else builder.feed(3);
  }

  return builder.build();
}
