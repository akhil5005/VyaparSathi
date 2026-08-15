import { prisma } from '../../lib/prisma.js';
import { extractor, type ImagePart } from '../../lib/anthropic.js';
import { badRequestCoded } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { bestMatch, rank } from './match.js';

/**
 * Reading a supplier's bill off a photograph.
 *
 * Entering purchases is the slowest job in the shop and the one whose mistakes
 * travel furthest: a supplier bill sets the moving-average cost, so a wrong
 * rate here quietly corrupts every margin, every stock valuation and every
 * "am I making money on this line" answer afterwards. It is also the one task
 * always performed with the source document physically in hand, which makes it
 * the safest thing to automate — the check is free.
 *
 * Three rules hold this together:
 *
 *  1. **Nothing is written.** This returns a draft. The operator confirms it
 *     into the ordinary purchase form, which calls the ordinary service.
 *  2. **The model reads; it does not compute.** It reports what is printed.
 *     Taxes, landed cost and totals are recomputed by the existing purchase
 *     code from the confirmed figures — never taken from the model.
 *  3. **The model never invents a party or a product.** It returns the names
 *     as printed; matching them to records is done here, deterministically,
 *     and an uncertain match is offered as a choice rather than applied.
 */

/** What the model is asked for: what the page says, and nothing derived. */
interface RawBill {
  supplierName?: string;
  supplierGstin?: string;
  invoiceNumber?: string;
  /// As printed, any format. Parsed here rather than by the model.
  invoiceDate?: string;
  freightCharges?: string;
  otherCharges?: string;
  invoiceTotal?: string;
  lines?: {
    description?: string;
    quantity?: string;
    unit?: string;
    rate?: string;
    amount?: string;
    hsnCode?: string;
  }[];
  notes?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    supplierName: { type: 'string', description: 'Seller name exactly as printed' },
    supplierGstin: { type: 'string', description: '15-character GSTIN of the seller if shown' },
    invoiceNumber: { type: 'string', description: "The supplier's own invoice number" },
    invoiceDate: { type: 'string', description: 'Invoice date exactly as printed' },
    freightCharges: { type: 'string', description: 'Freight or transport charge, digits only' },
    otherCharges: { type: 'string', description: 'Any other charge, digits only' },
    invoiceTotal: { type: 'string', description: 'Grand total as printed, digits only' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Item description as printed' },
          quantity: { type: 'string', description: 'Quantity, digits only' },
          unit: { type: 'string', description: 'Unit as printed — KG, REAM, PKT, NOS' },
          rate: { type: 'string', description: 'Rate per unit, digits only' },
          amount: { type: 'string', description: 'Line amount as printed, digits only' },
          hsnCode: { type: 'string', description: 'HSN code if printed against the line' },
        },
      },
    },
    notes: { type: 'string', description: 'Anything unclear or unreadable, in one sentence' },
  },
} as const;

const SYSTEM = [
  'You read Indian GST supplier invoices for a paper merchant and report exactly what is printed.',
  '',
  'Rules:',
  '- Report only what you can actually see. Leave a field out rather than guessing it.',
  '- Never calculate. Do not derive a rate from an amount, or a total from lines.',
  '- Numbers must be plain digits: "1,25,000.50" is "125000.50". No currency symbols, no commas.',
  '- Quantities and rates belong to the line they are printed on.',
  '- The seller is the party issuing the bill, not the buyer. On a bill addressed',
  '  to this shop, the shop is the buyer — do not report it as the supplier.',
  '- If the page is unreadable, blurred or is not an invoice, say so in notes and',
  '  return no lines rather than inventing any.',
].join('\n');

export interface ScannedLine {
  description: string;
  quantity: string | null;
  unit: string | null;
  rate: string | null;
  amount: string | null;
  hsnCode: string | null;
  /// Best guess at the product, plus the alternatives, both possibly empty.
  match: { productId: string; name: string; score: number; confident: boolean } | null;
  candidates: { productId: string; name: string; score: number }[];
}

export interface ScannedBill {
  supplier: {
    nameOnBill: string | null;
    gstinOnBill: string | null;
    match: { partyId: string; displayName: string; score: number; confident: boolean } | null;
    candidates: { partyId: string; displayName: string; score: number }[];
  };
  invoiceNumber: string | null;
  /// ISO date, or null when the printed date could not be read confidently.
  invoiceDate: string | null;
  freightCharges: string | null;
  otherCharges: string | null;
  /// What the bill says the total is. Compared on screen against what this
  /// app computes from the lines — a mismatch means something was misread.
  invoiceTotal: string | null;
  lines: ScannedLine[];
  notes: string | null;
  warnings: { code: string; message: string }[];
}

/**
 * Indian bills are overwhelmingly day-first: 03/04/2026 is 3 April, not 4 March.
 * Anything that cannot be read with confidence returns null rather than a guess
 * — a wrong purchase date lands the credit in the wrong return period.
 */
export function parseIndianDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();

  const numeric = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rejects 31 February and friends, which Date would roll over silently.
    if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
    return date.toISOString().slice(0, 10);
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const worded = /^(\d{1,2})[\s\-]*([a-zA-Z]{3,})[\s\-]*(\d{2}|\d{4})$/.exec(text);
  if (worded) {
    const month = MONTHS.indexOf(worded[2]!.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const day = Number(worded[1]);
    let year = Number(worded[3]);
    if (year < 100) year += 2000;
    if (day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  }

  return null;
}

/// Digits only. The model is told to send these clean; this is the guard for
/// when it does not, because "₹1,25,000/-" must never reach a Decimal.
export function cleanAmount(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned || Number.isNaN(Number(cleaned))) return null;
  return cleaned;
}

export async function scanPurchaseBill(
  businessId: string,
  images: ImagePart[],
): Promise<ScannedBill> {
  if (!extractor.available) {
    throw badRequestCoded(
      'AI_UNAVAILABLE',
      'Bill scanning is switched off because no AI key is configured on this deployment. Enter the bill by hand, or set ANTHROPIC_API_KEY.',
    );
  }

  const result = await extractor.extract<RawBill>({
    system: SYSTEM,
    prompt:
      'Read this supplier invoice and record what is printed on it. ' +
      'If several pages are attached they are one invoice.',
    images,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });

  if (!result.ok) {
    logger.error({ reason: result.reason }, 'Bill scan failed');
    throw badRequestCoded(
      'SCAN_FAILED',
      'Could not read that image. Try a straighter, better-lit photo of the whole bill — or enter it by hand.',
    );
  }

  logger.info({ usage: result.usage }, 'Bill scanned');
  return await resolveAgainstMasters(businessId, result.value);
}

/**
 * Turning names printed on paper into records, without ever choosing silently.
 *
 * Split out from the model call so it can be tested with a fixed `RawBill` and
 * no network — the matching is where a bill lands on the wrong account, so it
 * is the part that most needs tests.
 */
export async function resolveAgainstMasters(
  businessId: string,
  raw: RawBill,
): Promise<ScannedBill> {
  const [parties, products] = await Promise.all([
    prisma.party.findMany({
      where: { businessId, isActive: true, partyType: { in: ['SUPPLIER', 'BOTH'] } },
      select: { id: true, displayName: true, legalName: true, gstin: true },
    }),
    prisma.product.findMany({
      where: { businessId, isActive: true },
      select: { id: true, name: true, aliasNames: true, sku: true },
    }),
  ]);

  const warnings: ScannedBill['warnings'] = [];

  /**
   * A GSTIN is an identifier, not a name — if the bill shows one and it is on
   * file, that is a certainty no amount of string similarity can beat.
   */
  const printedGstin = raw.supplierGstin?.trim().toUpperCase();
  const byGstin = printedGstin ? parties.find((p) => p.gstin === printedGstin) : undefined;

  const nameMatch = raw.supplierName
    ? bestMatch(raw.supplierName, parties, (p) => [p.displayName, p.legalName ?? ''])
    : null;

  const supplierMatch = byGstin
    ? { partyId: byGstin.id, displayName: byGstin.displayName, score: 1, confident: true }
    : nameMatch
      ? {
          partyId: nameMatch.item.id,
          displayName: nameMatch.item.displayName,
          score: Number(nameMatch.score.toFixed(2)),
          confident: nameMatch.confident,
        }
      : null;

  if (!supplierMatch) {
    warnings.push({
      code: 'SUPPLIER_UNKNOWN',
      message: raw.supplierName
        ? `"${raw.supplierName}" is not a supplier on file. Pick one, or add them first.`
        : 'No supplier name could be read from the bill. Pick one.',
    });
  } else if (!supplierMatch.confident) {
    warnings.push({
      code: 'SUPPLIER_UNCERTAIN',
      message: `The supplier looks like "${supplierMatch.displayName}", but not certainly. Check it before saving.`,
    });
  }

  const lines: ScannedLine[] = (raw.lines ?? []).map((line) => {
    const description = (line.description ?? '').trim();
    const match = description
      ? bestMatch(description, products, (p) => [p.name, ...(p.aliasNames ?? []), p.sku ?? ''])
      : null;

    return {
      description,
      quantity: cleanAmount(line.quantity),
      unit: line.unit?.trim() || null,
      rate: cleanAmount(line.rate),
      amount: cleanAmount(line.amount),
      hsnCode: line.hsnCode?.replace(/\D/g, '') || null,
      match: match
        ? {
            productId: match.item.id,
            name: match.item.name,
            score: Number(match.score.toFixed(2)),
            confident: match.confident,
          }
        : null,
      candidates: rank(description, products, (p) => [p.name, ...(p.aliasNames ?? [])], {
        limit: 3,
      }).map((c) => ({ productId: c.item.id, name: c.item.name, score: Number(c.score.toFixed(2)) })),
    };
  });

  const unmatched = lines.filter((line) => !line.match).length;
  if (unmatched > 0) {
    warnings.push({
      code: 'PRODUCTS_UNMATCHED',
      message: `${unmatched} of ${lines.length} line${lines.length === 1 ? '' : 's'} could not be matched to a product. Pick each one, or add the product first.`,
    });
  }

  const uncertain = lines.filter((line) => line.match && !line.match.confident).length;
  if (uncertain > 0) {
    warnings.push({
      code: 'PRODUCTS_UNCERTAIN',
      message: `${uncertain} line${uncertain === 1 ? '' : 's'} matched a product only loosely. Check each before saving.`,
    });
  }

  const missingRate = lines.filter((line) => !line.rate || !line.quantity).length;
  if (missingRate > 0) {
    warnings.push({
      code: 'FIGURES_MISSING',
      message: `${missingRate} line${missingRate === 1 ? '' : 's'} is missing a quantity or a rate. These set the cost of the stock, so they cannot be guessed — read them off the bill.`,
    });
  }

  if (lines.length === 0) {
    warnings.push({
      code: 'NO_LINES',
      message:
        'No item lines could be read. If the photo is blurred or cropped, take another of the whole bill.',
    });
  }

  const invoiceDate = parseIndianDate(raw.invoiceDate);
  if (raw.invoiceDate && !invoiceDate) {
    warnings.push({
      code: 'DATE_UNREADABLE',
      message: `The date "${raw.invoiceDate}" could not be read reliably. Set it yourself — it decides which return period the credit falls in.`,
    });
  }

  return {
    supplier: {
      nameOnBill: raw.supplierName?.trim() || null,
      gstinOnBill: printedGstin ?? null,
      match: supplierMatch,
      candidates: raw.supplierName
        ? rank(raw.supplierName, parties, (p) => [p.displayName, p.legalName ?? '']).map((c) => ({
            partyId: c.item.id,
            displayName: c.item.displayName,
            score: Number(c.score.toFixed(2)),
          }))
        : [],
    },
    invoiceNumber: raw.invoiceNumber?.trim() || null,
    invoiceDate,
    freightCharges: cleanAmount(raw.freightCharges),
    otherCharges: cleanAmount(raw.otherCharges),
    invoiceTotal: cleanAmount(raw.invoiceTotal),
    lines,
    notes: raw.notes?.trim() || null,
    warnings,
  };
}
