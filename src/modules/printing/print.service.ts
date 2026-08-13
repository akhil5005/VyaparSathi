import type { PrinterProfile } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { STATE_CODES } from '../../lib/gstin.js';
import { charsPerLine } from './escpos.js';
import { renderInvoicePdf, type PdfBusiness, type PdfInvoice, type PdfOptions } from './invoicePdf.js';
import { buildReceiptLines, renderReceipt, type ReceiptInvoice } from './receipt.js';
import { dispatch, type DispatchResult } from './printer.js';

/**
 * The layer between the database and the two renderers.
 *
 * The renderers take plain shapes, not Prisma rows, so they can be tested with
 * a literal and reused later by the credit-note and purchase-order documents.
 * This file is the only place that knows both.
 */

/** The three copies Rule 46(1) requires for a supply of goods. */
export const COPY_LABELS = {
  ORIGINAL: 'ORIGINAL FOR RECIPIENT',
  DUPLICATE: 'DUPLICATE FOR TRANSPORTER',
  TRIPLICATE: 'TRIPLICATE FOR SUPPLIER',
} as const;

export type CopyType = keyof typeof COPY_LABELS;

async function loadInvoice(businessId: string, invoiceId: string) {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, businessId },
    include: { items: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!invoice) throw notFound('Invoice not found');

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business not found');

  return { invoice, business };
}

type LoadedInvoice = Awaited<ReturnType<typeof loadInvoice>>['invoice'];
type LoadedBusiness = Awaited<ReturnType<typeof loadInvoice>>['business'];

function toPdfBusiness(business: LoadedBusiness): PdfBusiness {
  return {
    legalName: business.legalName,
    tradeName: business.tradeName,
    gstin: business.gstin,
    stateName: business.stateName,
    stateCode: business.stateCode,
    addressLine1: business.addressLine1,
    addressLine2: business.addressLine2,
    city: business.city,
    pincode: business.pincode,
    phone: business.phone,
    email: business.email,
    bankName: business.bankName,
    bankAccountNumber: business.bankAccountNumber,
    bankIfsc: business.bankIfsc,
    upiId: business.upiId,
    invoiceTerms: business.invoiceTerms,
    invoiceFooter: business.invoiceFooter,
    hsnDigits: business.hsnDigits,
  };
}

function toPdfInvoice(invoice: LoadedInvoice): PdfInvoice {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    partyName: invoice.partyName,
    partyGstin: invoice.partyGstin,
    partyAddress: invoice.partyAddress,
    partyStateCode: invoice.partyStateCode,
    partyPhone: invoice.partyPhone,
    supplyType: invoice.supplyType,
    placeOfSupply: invoice.placeOfSupply,
    reverseCharge: invoice.reverseCharge,
    items: invoice.items.map((item) => ({
      lineNumber: item.lineNumber,
      productName: item.productName,
      description: item.description,
      hsnCode: item.hsnCode,
      quantity: item.quantity,
      unitName: item.unitName,
      uqc: item.uqc,
      rate: item.rate,
      discountAmount: item.discountAmount,
      discountPercent: item.discountPercent,
      taxableValue: item.taxableValue,
      cgstRate: item.cgstRate,
      cgstAmount: item.cgstAmount,
      sgstRate: item.sgstRate,
      sgstAmount: item.sgstAmount,
      igstRate: item.igstRate,
      igstAmount: item.igstAmount,
      cessRate: item.cessRate,
      cessAmount: item.cessAmount,
      lineTotal: item.lineTotal,
    })),
    taxableValue: invoice.taxableValue,
    totalDiscount: invoice.totalDiscount,
    totalCgst: invoice.totalCgst,
    totalSgst: invoice.totalSgst,
    totalIgst: invoice.totalIgst,
    totalCess: invoice.totalCess,
    freightCharges: invoice.freightCharges,
    otherCharges: invoice.otherCharges,
    roundOff: invoice.roundOff,
    grandTotal: invoice.grandTotal,
    amountInWords: invoice.amountInWords,
    notes: invoice.notes,
    transportName: invoice.transportName,
    vehicleNumber: invoice.vehicleNumber,
  };
}

function toReceiptInvoice(invoice: LoadedInvoice): ReceiptInvoice {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    partyName: invoice.partyName,
    partyGstin: invoice.partyGstin,
    partyPhone: invoice.partyPhone,
    supplyType: invoice.supplyType,
    items: invoice.items.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      unitName: item.unitName,
      rate: item.rate,
      taxableValue: item.taxableValue,
      cgstRate: item.cgstRate,
      sgstRate: item.sgstRate,
      igstRate: item.igstRate,
      lineTotal: item.lineTotal,
    })),
    taxableValue: invoice.taxableValue,
    totalCgst: invoice.totalCgst,
    totalSgst: invoice.totalSgst,
    totalIgst: invoice.totalIgst,
    totalCess: invoice.totalCess,
    freightCharges: invoice.freightCharges,
    otherCharges: invoice.otherCharges,
    roundOff: invoice.roundOff,
    grandTotal: invoice.grandTotal,
    amountInWords: invoice.amountInWords,
    amountPaid: invoice.amountPaid,
  };
}

/**
 * `printedCount` is a counter, not an audit trail — a reprint is not an event
 * worth a row, but "this invoice has been printed nine times" is worth knowing
 * when a customer claims they never got one.
 */
const countPrint = (invoiceId: string) =>
  prisma.salesInvoice.update({
    where: { id: invoiceId },
    data: { printedCount: { increment: 1 } },
  });

export interface InvoicePdfOptions {
  copy?: CopyType;
  /// Skip the counter for a print preview the operator only looks at.
  countAsPrint?: boolean;
  unicodeFontPath?: string;
}

export async function generateInvoicePdf(
  businessId: string,
  invoiceId: string,
  options: InvoicePdfOptions = {},
): Promise<{ pdf: Buffer; filename: string }> {
  const { invoice, business } = await loadInvoice(businessId, invoiceId);

  const pdfOptions: PdfOptions = {
    copyLabel: options.copy ? COPY_LABELS[options.copy] : undefined,
    stateName: STATE_CODES[invoice.placeOfSupply],
    ...(options.unicodeFontPath ? { unicodeFontPath: options.unicodeFontPath } : {}),
  };

  const pdf = await renderInvoicePdf(toPdfBusiness(business), toPdfInvoice(invoice), pdfOptions);

  if (options.countAsPrint !== false) await countPrint(invoice.id);

  // Slashes are legal in an invoice number ("INV/2026-27/0001") and illegal in
  // a filename on every platform we might land on.
  const safeNumber = (invoice.invoiceNumber ?? `draft-${invoice.id.slice(-6)}`).replace(
    /[^A-Za-z0-9._-]/g,
    '-',
  );

  return { pdf, filename: `invoice-${safeNumber}.pdf` };
}

async function resolveProfile(businessId: string, printerProfileId?: string) {
  if (printerProfileId) {
    const profile = await prisma.printerProfile.findFirst({
      where: { id: printerProfileId, businessId },
    });
    if (!profile) throw notFound('Printer profile not found');
    return profile;
  }

  return prisma.printerProfile.findFirst({
    where: { businessId, isActive: true, isDefault: true },
  });
}

export interface ReceiptOptions {
  printerProfileId?: string;
  /// Overrides the profile, for previewing a 58mm roll on screen.
  width?: number;
  showBalance?: boolean;
  copyLabel?: string;
  countAsPrint?: boolean;
}

/**
 * Builds the receipt without sending it.
 *
 * Returns both the text lines and the ESC/POS bytes: the lines drive an on-screen
 * preview, the bytes go to the device. Base64 rather than raw Buffer because
 * this crosses JSON on its way to a browser that will hand it to WebUSB.
 */
export async function generateReceipt(
  businessId: string,
  invoiceId: string,
  options: ReceiptOptions = {},
): Promise<{
  lines: string[];
  escpos: string;
  width: number;
  profile: PrinterProfile | null;
}> {
  const { invoice, business } = await loadInvoice(businessId, invoiceId);
  const profile = await resolveProfile(businessId, options.printerProfileId);

  const width =
    options.width ?? (profile ? charsPerLine(profile.paperWidth, profile.charactersPerLine) : 48);

  const lines = buildReceiptLines(
    {
      legalName: business.legalName,
      tradeName: business.tradeName,
      gstin: business.gstin,
      addressLine1: business.addressLine1,
      addressLine2: business.addressLine2,
      city: business.city,
      pincode: business.pincode,
      phone: business.phone,
      invoiceFooter: business.invoiceFooter,
    },
    toReceiptInvoice(invoice),
    {
      width,
      ...(options.showBalance !== undefined ? { showBalance: options.showBalance } : {}),
      ...(options.copyLabel ? { copyLabel: options.copyLabel } : {}),
    },
  );

  const escpos = renderReceipt(lines, {
    ...(profile ? { codePage: profile.codePage, cutAfterPrint: profile.cutAfterPrint } : {}),
    ...(profile ? { openCashDrawer: profile.openCashDrawer, copies: profile.copies } : {}),
  });

  if (options.countAsPrint) await countPrint(invoice.id);

  return { lines, escpos: escpos.toString('base64'), width, profile };
}

/** Builds the receipt and hands it to the transport. */
export async function printReceipt(
  businessId: string,
  invoiceId: string,
  options: ReceiptOptions = {},
): Promise<DispatchResult & { lines: string[]; escposBase64?: string }> {
  const built = await generateReceipt(businessId, invoiceId, {
    ...options,
    countAsPrint: false,
  });

  if (!built.profile) {
    throw notFound('No printer selected and no default printer configured');
  }

  const result = await dispatch(Buffer.from(built.escpos, 'base64'), built.profile);
  await countPrint(invoiceId);

  return {
    ...result,
    // The buffer itself is dropped from the JSON response; base64 is what a
    // browser can actually act on.
    payload: undefined,
    ...(result.payload ? { escposBase64: result.payload.toString('base64') } : {}),
    lines: built.lines,
  };
}
