import { z } from 'zod';
import { businessDate } from '../../lib/dates.js';
import { InvoiceStatus, NoteReason, NoteType } from '@prisma/client';

const decimalString = (label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && !Number.isNaN(Number(v)), `${label} must be a number`);

const positiveDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) > 0, `${label} must be greater than zero`);

const nonNegativeDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) >= 0, `${label} cannot be negative`);

export const noteItemSchema = z.object({
  /// The line on the original invoice this is being credited against. Required,
  /// because both the tax rate and the quantity ceiling come from it.
  invoiceItemId: z.string().min(1),
  quantity: positiveDecimal('Quantity'),
  /// Defaults to the original line's rate. Supply a different one for a
  /// rate-reduction note, where the credit is the *difference* per unit.
  rate: nonNegativeDecimal('Rate').optional(),
});

export const createNoteSchema = z.object({
  noteType: z.nativeEnum(NoteType),
  /// Exactly one of these. Credit notes are only valid against a sale.
  againstSalesInvoiceId: z.string().min(1).optional(),
  againstPurchaseInvoiceId: z.string().min(1).optional(),

  reason: z.nativeEnum(NoteReason),
  reasonNote: z.string().trim().max(500).optional(),
  noteDate: businessDate().optional(),

  items: z.array(noteItemSchema).min(1, 'Add at least one line').max(200),

  /// Defaults from the reason: a return moves goods, a rate correction doesn't.
  affectsStock: z.boolean().optional(),

  issue: z.boolean().optional(),
}).refine(
  (v) =>
    (v.againstSalesInvoiceId !== undefined) !== (v.againstPurchaseInvoiceId !== undefined),
  { message: 'Give exactly one of againstSalesInvoiceId or againstPurchaseInvoiceId' },
);

export const previewNoteSchema = createNoteSchema.innerType().omit({ issue: true });

export const listNotesQuerySchema = z.object({
  partyId: z.string().optional(),
  noteType: z.nativeEnum(NoteType).optional(),
  status: z.nativeEnum(InvoiceStatus).optional(),
  reason: z.nativeEnum(NoteReason).optional(),
  fromDate: businessDate().optional(),
  toDate: businessDate().optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export const cancelNoteSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — it goes on the audit trail').max(500),
});
