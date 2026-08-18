import { z } from 'zod';
import { businessDate } from '../../lib/dates.js';
import { GstRegistrationType, PartyType } from '@prisma/client';
import { gstinSchema, phoneSchema } from '../auth/auth.schemas.js';
import { STATE_CODES } from '../../lib/gstin.js';

/// Numeric strings, kept as strings so they reach Prisma.Decimal without a
/// float round-trip.
const decimalString = (label: string) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && !Number.isNaN(Number(v)), `${label} must be a number`);

const nonNegativeDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) >= 0, `${label} cannot be negative`);

const positiveDecimal = (label: string) =>
  decimalString(label).refine((v) => Number(v) > 0, `${label} must be greater than zero`);

const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, 'State code must be 2 digits')
  .refine((v) => v in STATE_CODES, 'Unknown state code');

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const createUnitSchema = z.object({
  name: z.string().trim().min(1).max(50),
  symbol: z.string().trim().min(1).max(10),
  /// Government Unit Quantity Code. Required on GST returns — reams are
  /// normally reported as NOS or PAC.
  uqc: z.string().trim().toUpperCase().min(2).max(8),
  allowDecimal: z.boolean().optional(),
});

export const updateUnitSchema = createUnitSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// HSN
// ---------------------------------------------------------------------------

export const createHsnSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'HSN must be 4 to 8 digits'),
  description: z.string().trim().min(2).max(300),
  /// Optional first rate, so the common case is one call.
  gstRate: nonNegativeDecimal('GST rate').optional(),
  cessRate: nonNegativeDecimal('Cess rate').optional(),
  effectiveFrom: businessDate().optional(),
});

export const updateHsnSchema = z.object({
  description: z.string().trim().min(2).max(300),
});

export const addHsnRateSchema = z.object({
  gstRate: nonNegativeDecimal('GST rate').refine(
    (v) => Number(v) <= 100,
    'GST rate cannot exceed 100%',
  ),
  cessRate: nonNegativeDecimal('Cess rate').optional(),
  /// The date the new rate starts applying. The previous open rate is closed
  /// the instant before this.
  effectiveFrom: businessDate(),
  notes: z.string().max(300).optional(),
});

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export const createPartySchema = z
  .object({
    displayName: z.string().trim().min(2).max(150),
    legalName: z.string().trim().max(200).optional(),
    partyType: z.nativeEnum(PartyType).optional(),

    gstin: gstinSchema.optional(),
    gstRegistrationType: z.nativeEnum(GstRegistrationType).optional(),
    /// Required only when there is no GSTIN to derive it from.
    stateCode: stateCodeSchema.optional(),

    phone: phoneSchema.optional(),
    alternatePhone: phoneSchema.optional(),
    whatsappNumber: phoneSchema.optional(),
    email: z.string().email().optional(),
    contactPerson: z.string().trim().max(120).optional(),

    addressLine1: z.string().trim().max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional(),

    /// Positive = they owe us, as at the switchover date.
    openingBalance: decimalString('Opening balance').optional(),
    openingBalanceDate: businessDate().optional(),
    creditLimit: nonNegativeDecimal('Credit limit').optional(),
    creditDays: z.number().int().min(0).max(365).optional(),

    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.gstin !== undefined || v.stateCode !== undefined, {
    message: 'Give a GSTIN, or a state code for an unregistered customer — it decides CGST/SGST vs IGST',
    path: ['stateCode'],
  });

export const updatePartySchema = createPartySchema
  .innerType()
  .partial()
  .extend({
    isActive: z.boolean().optional(),
    /**
     * Explicitly null clears it — a dealer who surrendered their registration.
     * `.partial()` can only say "not given", which is a different thing: it
     * leaves the old GSTIN in place. Without this the UI would appear to
     * unregister a party and silently not.
     */
    gstin: gstinSchema.nullable().optional(),
  })
  // Opening balance is set once, at migration. Changing it later would silently
  // desync the ledger, so it has to go through an adjustment entry instead.
  .omit({ openingBalance: true, openingBalanceDate: true });

export const setPartyRateSchema = z.object({
  productId: z.string().min(1),
  unitId: z.string().min(1),
  rate: nonNegativeDecimal('Rate'),
  effectiveFrom: businessDate().optional(),
});

export const listPartiesQuerySchema = z.object({
  search: z.string().max(100).optional(),
  partyType: z.nativeEnum(PartyType).optional(),
  isActive: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /// Only parties with money outstanding — the udhaar list.
  withBalanceOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const createProductSchema = z.object({
  name: z.string().trim().min(2).max(200),
  /// Alternative names your father says out loud. Voice matching searches these.
  aliasNames: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  sku: z.string().trim().max(50).optional(),
  brand: z.string().trim().max(100).optional(),
  description: z.string().max(500).optional(),

  hsnCodeId: z.string().min(1, 'Pick an HSN code — it decides the GST rate'),
  baseUnitId: z.string().min(1, 'Pick the unit stock is counted in'),

  // Paper attributes. Supplying all three lets the kg conversion be derived.
  gsm: z.number().int().positive().max(2000).optional(),
  sheetSize: z.string().trim().max(30).optional(),
  sheetsPerReam: z.number().int().positive().max(100_000).optional(),
  /// Override the derived weight when the spec math doesn't match reality.
  weightPerBaseUnitKg: positiveDecimal('Weight per unit').optional(),

  defaultSaleRate: nonNegativeDecimal('Sale rate').optional(),
  defaultPurchaseRate: nonNegativeDecimal('Purchase rate').optional(),
  defaultSaleUnitId: z.string().optional(),
  defaultPurchaseUnitId: z.string().optional(),

  reorderLevel: nonNegativeDecimal('Reorder level').optional(),

  /// When true and the paper spec is complete, a KG conversion row is created
  /// automatically. Default true — this is the whole point of the spec fields.
  autoDeriveKgConversion: z.boolean().optional(),

  openingStock: nonNegativeDecimal('Opening stock').optional(),
  openingStockRate: nonNegativeDecimal('Opening stock rate').optional(),
});

export const updateProductSchema = createProductSchema
  .partial()
  .omit({ openingStock: true, openingStockRate: true, baseUnitId: true })
  .extend({ isActive: z.boolean().optional() });

export const setProductUnitSchema = z.object({
  unitId: z.string().min(1),
  /// Multiply a quantity in this unit by this to get base units.
  /// A packet of 5 reams (base = ream) is 5.
  conversionToBase: positiveDecimal('Conversion factor'),
  isPurchaseDefault: z.boolean().optional(),
  isSalesDefault: z.boolean().optional(),
});

export const openingStockSchema = z.object({
  quantity: nonNegativeDecimal('Quantity'),
  /// Cost per base unit. Seeds the weighted-average cost used for margin.
  ratePerBaseUnit: nonNegativeDecimal('Rate'),
  asOfDate: businessDate().optional(),
});

export const adjustStockSchema = z.object({
  /// Signed: negative for damage or shrinkage.
  quantity: decimalString('Quantity').refine((v) => Number(v) !== 0, 'Quantity cannot be zero'),
  reason: z.string().trim().min(3, 'Give a reason — it goes on the audit trail').max(300),
  asOfDate: businessDate().optional(),
});

export const listProductsQuerySchema = z.object({
  search: z.string().max(100).optional(),
  hsnCodeId: z.string().optional(),
  isActive: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /// Only products at or below their reorder level.
  lowStockOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
