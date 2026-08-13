/**
 * Ream weight, mirrored from the server's `src/modules/masters/paperWeight.ts`.
 *
 * Duplicated on purpose, and only for *preview*. The server derives and stores
 * the real figure when the product is saved; this copy exists so the operator
 * can see "one A4 ream of 75 gsm weighs 2.3389 kg" while still typing, and
 * catch a mistyped gsm before it becomes a conversion factor that quietly
 * misprices every kilogram purchase.
 *
 * Unlike the money paths, a float is fine here: this number is shown, never
 * stored, and the server recomputes it in Decimal.
 */

/// ISO 216 A-series, in millimetres.
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

const B_SERIES_MM: Record<string, [number, number]> = {
  B0: [1000, 1414],
  B1: [707, 1000],
  B2: [500, 707],
  B3: [353, 500],
  B4: [250, 353],
  B5: [176, 250],
};

const MM_PER_INCH = 25.4;

/**
 * Sheet area in square metres, or null if the size cannot be read.
 *
 * Accepts "A4", "210x297mm", "70x100cm", "23x36in" — and bare numbers like
 * "23x36", which are read as **inches**, because that is the Indian paper
 * trade's convention (23x36, 20x30 and 25x36 are all inch sizes).
 */
export function sheetAreaM2(spec: string): number | null {
  const cleaned = spec.trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return null;

  const iso = A_SERIES_MM[cleaned] ?? B_SERIES_MM[cleaned];
  if (iso) return (iso[0] / 1000) * (iso[1] / 1000);

  const match = cleaned.match(/^(\d+(?:\.\d+)?)[X*×](\d+(?:\.\d+)?)(MM|CM|IN|INCH|")?$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const factor = match[3] === 'MM' ? 1 : match[3] === 'CM' ? 10 : MM_PER_INCH;
  return ((width * factor) / 1000) * ((height * factor) / 1000);
}

/** Weight of one ream in kg, or null when the spec is incomplete. */
export function reamWeightKg(
  gsm: number,
  sheetSize: string,
  sheetsPerReam: number,
): number | null {
  if (!gsm || !sheetSize || !sheetsPerReam) return null;
  if (gsm <= 0 || sheetsPerReam <= 0) return null;

  const area = sheetAreaM2(sheetSize);
  if (area === null) return null;

  // gsm is grams per m²; ÷1000 converts the total to kilograms.
  return (gsm * area * sheetsPerReam) / 1000;
}
