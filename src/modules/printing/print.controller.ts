import { handler, scopeOf } from '../../lib/http.js';
import * as print from './print.service.js';
import * as printers from './printerProfile.service.js';
import {
  createPrinterSchema,
  invoicePdfQuerySchema,
  listPrintersQuerySchema,
  printReceiptSchema,
  receiptQuerySchema,
  updatePrinterSchema,
} from './print.schemas.js';

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const invoicePdf = handler(async (req, res) => {
  const query = invoicePdfQuerySchema.parse(req.query);
  const { pdf, filename } = await print.generateInvoicePdf(
    scopeOf(req).businessId,
    req.params.invoiceId!,
    {
      ...(query.copy ? { copy: query.copy } : {}),
      countAsPrint: !query.preview,
    },
  );

  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `${query.download ? 'attachment' : 'inline'}; filename="${filename}"`,
      // A reissued invoice must never come back from a proxy cache.
      'Cache-Control': 'no-store',
    })
    .end(pdf);
});

/// The receipt as text lines plus base64 ESC/POS — a preview the operator can
/// read, and bytes a USB/Bluetooth client can forward to the device itself.
export const receipt = handler(async (req, res) => {
  const query = receiptQuerySchema.parse(req.query);
  res.json(await print.generateReceipt(scopeOf(req).businessId, req.params.invoiceId!, query));
});

/// Actually sends it. Only works end-to-end for network printers; see printer.ts.
export const sendReceipt = handler(async (req, res) => {
  const input = printReceiptSchema.parse(req.body ?? {});
  res.json(await print.printReceipt(scopeOf(req).businessId, req.params.invoiceId!, input));
});

// ---------------------------------------------------------------------------
// Printer profiles
// ---------------------------------------------------------------------------

export const listPrinters = handler(async (req, res) => {
  const includeInactive = listPrintersQuerySchema.parse(req.query).includeInactive ?? false;
  res.json({ printers: await printers.listPrinters(scopeOf(req).businessId, includeInactive) });
});

export const createPrinter = handler(async (req, res) => {
  const input = createPrinterSchema.parse(req.body);
  res.status(201).json({ printer: await printers.createPrinter(scopeOf(req).businessId, input) });
});

export const updatePrinter = handler(async (req, res) => {
  const patch = updatePrinterSchema.parse(req.body);
  res.json({
    printer: await printers.updatePrinter(scopeOf(req).businessId, req.params.printerId!, patch),
  });
});

export const deletePrinter = handler(async (req, res) => {
  res.json(await printers.deletePrinter(scopeOf(req).businessId, req.params.printerId!));
});

export const testPrinter = handler(async (req, res) => {
  res.json(await printers.testPrinter(scopeOf(req).businessId, req.params.printerId!));
});
