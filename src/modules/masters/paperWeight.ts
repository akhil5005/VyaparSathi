import { Prisma } from '@prisma/client';
import { D, round4 } from '../../lib/money.js';

/**
 * Paper weight arithmetic — the thing that makes kg↔ream conversion
 * self-configuring instead of a number someone types in and gets wrong.
 *
 * A ream's weight is fully determined by three facts already on the product:
 *
 *     weight (kg) = gsm (g/m²) × sheet area (m²) × sheets per ream ÷ 1000
 *
 * So for JK Copier A4 75gsm, 500 sheets:
 *     75 × (0.210 × 0.297) × 500 ÷ 1000 = 2.3389 kg
 *
 * The mill bills in kg, the shop sells in reams. Deriving the factor from the
 * spec removes the most error-prone piece of data entry in the whole system.
 */

/// ISO 216 A-series, in millimetres. Standardised values, not computed —
/// the spec rounds each halving down to a whole millimetre.
const A_SERIES_MM: Record<string, [number, number]> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  A6: [105, 148],
  A7: [74, 105],
  A8: [52, 74],
};

/// ISO 216 B-series, in millimetres.
const B_SERIES_MM: Record<string, [number, number]> = {
  B0: [1000, 1414],
  B1: [707, 1000],
  B2: [500, 707],
  B3: [353, 500],
  B4: [250, 353],
  B5: [176, 250],
};

const MM_PER_INCH = 25.4;

export interface SheetDimensions {
  widthMm: number;
  heightMm: number;
  areaM2: number;
}

/**
 * Parses a sheet-size spec into dimensions.
 *
 * Accepted forms:
 *   "A4", "a3", "B5"            — ISO series
 *   "210x297mm", "70x100cm"     — explicit metric
 *   "23x36in"                   — explicit imperial
 *   "23x36"                     — bare numbers are read as INCHES, which is the
 *                                 Indian paper-trade convention (23x36, 20x30,
 *                                 25x36 are all inch sizes).
 */
export function parseSheetSize(spec: string): SheetDimensions | null {
  const cleaned = spec.trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return null;

  const iso = A_SERIES_MM[cleaned] ?? B_SERIES_MM[cleaned];
  if (iso) return dimensions(iso[0], iso[1]);

  const match = cleaned.match(/^(\d+(?:\.\d+)?)[X*×](\d+(?:\.\d+)?)(MM|CM|IN|INCH|")?$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  switch (match[3]) {
    case 'MM':
      return dimensions(width, height);
    case 'CM':
      return dimensions(width * 10, height * 10);
    // No suffix falls through to inches — see the doc comment.
    default:
      return dimensions(width * MM_PER_INCH, height * MM_PER_INCH);
  }
}

function dimensions(widthMm: number, heightMm: number): SheetDimensions {
  return {
    widthMm,
    heightMm,
    areaM2: (widthMm / 1000) * (heightMm / 1000),
  };
}

export interface PaperSpec {
  gsm: number;
  sheetSize: string;
  sheetsPerReam: number;
}

/**
 * Weight of one ream in kilograms, or null when the spec is incomplete or the
 * sheet size can't be parsed. Null is a normal outcome — plenty of products
 * (envelopes, files) have no meaningful gsm.
 */
export function reamWeightKg(spec: Partial<PaperSpec>): Prisma.Decimal | null {
  const { gsm, sheetSize, sheetsPerReam } = spec;
  if (!gsm || !sheetSize || !sheetsPerReam) return null;
  if (gsm <= 0 || sheetsPerReam <= 0) return null;

  const size = parseSheetSize(sheetSize);
  if (!size) return null;

  return round4(D(gsm).times(size.areaM2).times(sheetsPerReam).dividedBy(1000));
}

/**
 * How many base units one kilogram represents — i.e. the `conversionToBase`
 * for a KG `ProductUnit` when the base unit is a ream.
 *
 * If a ream weighs 2.3389 kg then 1 kg = 0.4276 reams.
 */
export function kgToBaseUnitFactor(weightPerBaseUnitKg: Prisma.Decimal.Value): Prisma.Decimal | null {
  const weight = D(weightPerBaseUnitKg);
  if (weight.lessThanOrEqualTo(0)) return null;
  return round4(D(1).dividedBy(weight));
}

/**
 * Gross weight of a quantity, for the e-way bill. The portal wants a weight and
 * guessing it is a common reason for a rejected filing.
 */
export function grossWeightKg(
  baseQuantity: Prisma.Decimal.Value,
  weightPerBaseUnitKg: Prisma.Decimal.Value | null,
): Prisma.Decimal | null {
  if (weightPerBaseUnitKg === null) return null;
  return round4(D(baseQuantity).times(D(weightPerBaseUnitKg)));
}
