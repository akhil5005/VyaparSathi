import { z } from 'zod';
import { businessDate } from '../../lib/dates.js';
import { ChequeStatus, PaymentDirection, PaymentMode } from '@prisma/client';

const decimalString = (label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && !Number.isNaN(Number(v)), `${label} must be a number`);

const positiveDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) > 0, `${label} must be greater than zero`);

const nonNegativeDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) >= 0, `${label} cannot be negative`);

export const chequeDetailsSchema = z.object({
  chequeNumber: z.string().trim().min(1).max(20),
  bankName: z.string().trim().min(2).max(120),
  branchName: z.string().trim().max(120).optional(),
  /// The date written on the cheque. Often weeks ahead — that is the whole
  /// point of tracking cheques separately.
  chequeDate: businessDate(),
});

export const explicitAllocationSchema = z.object({
  invoiceId: z.string().min(1),
  amount: positiveDecimal('Allocation amount'),
});

export const recordPaymentSchema = z
  .object({
    partyId: z.string().min(1, 'Select a party'),
    direction: z.nativeEnum(PaymentDirection),
    amount: positiveDecimal('Amount'),
    mode: z.nativeEnum(PaymentMode),
    paymentDate: businessDate().optional(),

    referenceNumber: z.string().trim().max(60).optional(),
    bankName: z.string().trim().max(120).optional(),
    notes: z.string().max(1000).optional(),

    cheque: chequeDetailsSchema.optional(),

    /// Omit to settle oldest bills first, which is the normal behaviour.
    /// Supply to hand-pick which bills this money clears.
    allocations: z.array(explicitAllocationSchema).max(100).optional(),
    /// Set false to take the money purely on account without touching bills.
    autoAllocate: z.boolean().optional(),
  })
  .refine((v) => v.mode !== 'CHEQUE' || v.cheque !== undefined, {
    message: 'Cheque details are required when the mode is CHEQUE',
    path: ['cheque'],
  })
  .refine((v) => !(v.allocations !== undefined && v.autoAllocate === true), {
    message: 'Give explicit allocations or ask for auto-allocation, not both',
    path: ['allocations'],
  });

export const allocatePaymentSchema = z
  .object({
    allocations: z.array(explicitAllocationSchema).max(100).optional(),
    /// Spread whatever is on account across the oldest open bills.
    auto: z.boolean().optional(),
  })
  .refine((v) => v.allocations !== undefined || v.auto === true, {
    message: 'Give allocations or set auto to true',
  });

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — it goes on the audit trail').max(300),
});

export const bounceChequeSchema = z.object({
  reason: z.string().trim().min(3, 'Give the bank return reason').max(300),
  /// Bank charges recovered from the party. Posted to their ledger.
  bounceCharges: nonNegativeDecimal('Bounce charges').optional(),
  bouncedOn: businessDate().optional(),
});

export const updateChequeStatusSchema = z.object({
  status: z.nativeEnum(ChequeStatus),
  onDate: businessDate().optional(),
});

export const listPaymentsQuerySchema = z.object({
  partyId: z.string().optional(),
  direction: z.nativeEnum(PaymentDirection).optional(),
  mode: z.nativeEnum(PaymentMode).optional(),
  fromDate: businessDate().optional(),
  toDate: businessDate().optional(),
  /// Payments with money still sitting on account.
  unallocatedOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  includeReversed: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export const listChequesQuerySchema = z.object({
  partyId: z.string().optional(),
  status: z.nativeEnum(ChequeStatus).optional(),
  direction: z.nativeEnum(PaymentDirection).optional(),
  /// Cheques whose written date falls on or before this — "what can I bank?".
  dueBy: businessDate().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export const outstandingQuerySchema = z.object({
  partyId: z.string().optional(),
  asOf: businessDate().optional(),
  /// Only parties owing at least this much — hides the ₹40 stragglers.
  minBalance: nonNegativeDecimal('Minimum balance').optional(),
});
