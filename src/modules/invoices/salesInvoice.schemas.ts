import { z } from 'zod';
import { InvoiceStatus } from '@prisma/client';

/// Accepts a number or a numeric string (forms send strings) and keeps it as a
/// string so it reaches Prisma.Decimal without a float round-trip.
const decimalString = (label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && !Number.isNaN(Number(v)), `${label} must be a number`);

const positiveDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) > 0, `${label} must be greater than zero`);

const nonNegativeDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) >= 0, `${label} cannot be negative`);

export const invoiceItemSchema = z
  .object({
    productId: z.string().min(1),
    quantity: positiveDecimal('Quantity'),
    unitId: z.string().min(1).optional(),
    rate: nonNegativeDecimal('Rate').optional(),
    discountPercent: decimalString('Discount percent')
      .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Discount percent must be between 0 and 100')
      .optional(),
    discountAmount: nonNegativeDecimal('Discount amount').optional(),
    description: z.string().max(500).optional(),
  })
  .refine((item) => !(item.discountPercent !== undefined && item.discountAmount !== undefined), {
    message: 'Give either a discount percent or a discount amount, not both',
    path: ['discountAmount'],
  });

export const createSalesInvoiceSchema = z.object({
  partyId: z.string().min(1, 'Select a customer'),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  items: z.array(invoiceItemSchema).min(1, 'Add at least one item').max(200),
  freightCharges: nonNegativeDecimal('Freight').optional(),
  otherCharges: nonNegativeDecimal('Other charges').optional(),
  reverseCharge: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  transportName: z.string().max(200).optional(),
  vehicleNumber: z.string().max(20).optional(),
  createdViaVoice: z.boolean().optional(),
  voiceSessionId: z.string().max(100).optional(),
  /// Defaults to true — the common path is bill-and-print in one action.
  issue: z.boolean().optional(),
});

export const previewSalesInvoiceSchema = createSalesInvoiceSchema.omit({ issue: true });

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — it goes on the audit trail').max(500),
});

export const listInvoicesQuerySchema = z.object({
  partyId: z.string().optional(),
  status: z.nativeEnum(InvoiceStatus).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  unpaidOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
