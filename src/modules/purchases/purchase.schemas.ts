import { z } from 'zod';
import { businessDate } from '../../lib/dates.js';
import { InvoiceStatus } from '@prisma/client';

const decimalString = (label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && !Number.isNaN(Number(v)), `${label} must be a number`);

const positiveDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) > 0, `${label} must be greater than zero`);

const nonNegativeDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) >= 0, `${label} cannot be negative`);

export const purchaseItemSchema = z
  .object({
    productId: z.string().min(1),
    quantity: positiveDecimal('Quantity'),
    /// Unit as billed by the mill — usually kg.
    unitId: z.string().min(1).optional(),
    rate: nonNegativeDecimal('Rate'),
    discountPercent: decimalString('Discount percent')
      .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Discount percent must be between 0 and 100')
      .optional(),
    discountAmount: nonNegativeDecimal('Discount amount').optional(),
    /// Override when the supplier billed a different rate than our HSN master
    /// says. Their bill is what governs the credit we can claim.
    gstRate: decimalString('GST rate')
      .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'GST rate must be between 0 and 100')
      .optional(),
    cessRate: nonNegativeDecimal('Cess rate').optional(),
  })
  .refine((item) => !(item.discountPercent !== undefined && item.discountAmount !== undefined), {
    message: 'Give either a discount percent or a discount amount, not both',
    path: ['discountAmount'],
  });

export const createPurchaseSchema = z.object({
  partyId: z.string().min(1, 'Select a supplier'),
  /// The number printed on the supplier's bill. This is what GSTR-2B
  /// reconciliation matches on, so it matters more than our own reference.
  supplierInvoiceNumber: z.string().trim().min(1).max(50),
  supplierInvoiceDate: businessDate(),

  items: z.array(purchaseItemSchema).min(1, 'Add at least one item').max(200),

  freightCharges: nonNegativeDecimal('Freight').optional(),
  otherCharges: nonNegativeDecimal('Other charges').optional(),

  /// Reverse charge: we pay the tax instead of the supplier collecting it.
  reverseCharge: z.boolean().optional(),
  /// Set false for blocked credit, or a supplier we cannot claim against.
  itcEligible: z.boolean().optional(),

  /// Type the grand total off the paper bill and we will flag a mismatch
  /// before it reaches a return.
  supplierGrandTotal: nonNegativeDecimal('Supplier total').optional(),

  notes: z.string().max(2000).optional(),
  /// false keeps it a DRAFT — no stock, no ledger, no number.
  issue: z.boolean().optional(),
});

export const previewPurchaseSchema = createPurchaseSchema.omit({ issue: true });

export const cancelPurchaseSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — it goes on the audit trail').max(500),
});

export const claimItcSchema = z.object({
  /// Return period the credit is claimed in, "YYYY-MM".
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must look like 2026-07'),
  purchaseIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /// Claim every eligible unclaimed bill dated within the period.
  claimAllInPeriod: z.boolean().optional(),
});

export const listPurchasesQuerySchema = z.object({
  partyId: z.string().optional(),
  status: z.nativeEnum(InvoiceStatus).optional(),
  fromDate: businessDate().optional(),
  toDate: businessDate().optional(),
  unpaidOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /// Eligible bills whose credit has not been claimed yet — money on the table.
  itcPendingOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export const gstSummaryQuerySchema = z
  .object({
    /// Either a period, or an explicit range.
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    fromDate: businessDate().optional(),
    toDate: businessDate().optional(),
  })
  .refine((v) => v.period !== undefined || (v.fromDate !== undefined && v.toDate !== undefined), {
    message: 'Give a period like 2026-07, or both fromDate and toDate',
  });
