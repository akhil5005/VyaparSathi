import { z } from 'zod';
import { PaperWidth, PrinterConnection } from '@prisma/client';

/// IPv4, hostname, or IPv6 — a shop printer is nearly always a static IPv4 on
/// the LAN, but nothing here needs to forbid the others.
const host = z.string().trim().min(1).max(255);

/**
 * A flag that arrives either as a real JSON boolean (request body) or as a
 * query string.
 *
 * Not `z.coerce.boolean()`: that is `Boolean(value)`, so the string "false"
 * — which is exactly what `?preview=false` sends — coerces to `true`.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true');

export const createPrinterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  paperWidth: z.nativeEnum(PaperWidth).optional(),
  connection: z.nativeEnum(PrinterConnection).optional(),

  ipAddress: host.optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  deviceName: z.string().trim().max(120).optional(),
  macAddress: z.string().trim().max(32).optional(),

  codePage: z.coerce.number().int().min(0).max(255).optional(),
  /// A 58mm roll fits 32 characters, 80mm fits 48. Overridable because font-B
  /// printers fit more and some clones fit fewer.
  charactersPerLine: z.coerce.number().int().min(20).max(96).optional(),

  cutAfterPrint: booleanish.optional(),
  openCashDrawer: booleanish.optional(),
  copies: z.coerce.number().int().min(1).max(5).optional(),

  isDefault: booleanish.optional(),
});

export const updatePrinterSchema = createPrinterSchema.partial().extend({
  isActive: booleanish.optional(),
});

export const invoicePdfQuerySchema = z.object({
  copy: z.enum(['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']).optional(),
  /// `?download=true` forces a save dialog; the default opens in the browser's
  /// viewer, which is what the operator wants when checking a bill.
  download: booleanish.optional(),
  /// Looking, not printing — leaves `printedCount` alone.
  preview: booleanish.optional(),
});

export const receiptQuerySchema = z.object({
  printerProfileId: z.string().min(1).optional(),
  width: z.coerce.number().int().min(20).max(96).optional(),
  showBalance: booleanish.optional(),
  copyLabel: z.string().trim().max(40).optional(),
});

export const printReceiptSchema = receiptQuerySchema;

export const listPrintersQuerySchema = z.object({
  includeInactive: booleanish.optional(),
});
