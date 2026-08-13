import { Prisma, type SupplyType } from '@prisma/client';
import { D, round2, roundToRupee, sum, ZERO } from '../../lib/money.js';

/**
 * Pure GST arithmetic. No database, no Express, no side effects — so it can be
 * exhaustively unit-tested, which is exactly what you want for the code that
 * decides how much tax a customer is charged.
 *
 * The one rule that drives everything: if the place of supply is the same state
 * as the seller, GST splits into CGST + SGST at half the rate each. Otherwise
 * the whole rate is charged as IGST. Never both.
 */

export interface TaxRateInput {
  /// Total GST percent for the HSN, e.g. 5 / 12 / 18.
  gstRate: Prisma.Decimal;
  cessRate: Prisma.Decimal;
}

export interface LineTax {
  cgstRate: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstRate: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstRate: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  cessRate: Prisma.Decimal;
  cessAmount: Prisma.Decimal;
}

/**
 * Splits tax for one line.
 *
 * CGST and SGST are each computed and rounded independently rather than halving
 * a rounded total. On an odd-paise line the two halves can differ by a paisa —
 * that is correct and is what the GST portal expects; forcing them equal
 * produces a total that doesn't reconcile.
 */
export function computeLineTax(
  taxableValue: Prisma.Decimal,
  rates: TaxRateInput,
  supplyType: SupplyType,
): LineTax {
  const { gstRate, cessRate } = rates;
  const cessAmount = round2(taxableValue.times(cessRate).dividedBy(100));

  if (supplyType === 'INTRA_STATE') {
    const halfRate = gstRate.dividedBy(2);
    return {
      cgstRate: halfRate,
      cgstAmount: round2(taxableValue.times(halfRate).dividedBy(100)),
      sgstRate: halfRate,
      sgstAmount: round2(taxableValue.times(halfRate).dividedBy(100)),
      igstRate: ZERO(),
      igstAmount: ZERO(),
      cessRate,
      cessAmount,
    };
  }

  return {
    cgstRate: ZERO(),
    cgstAmount: ZERO(),
    sgstRate: ZERO(),
    sgstAmount: ZERO(),
    igstRate: gstRate,
    igstAmount: round2(taxableValue.times(gstRate).dividedBy(100)),
    cessRate,
    cessAmount,
  };
}

export interface LineAmountInput {
  quantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  /// Percent discount off the gross. Ignored when discountAmount is supplied.
  discountPercent?: Prisma.Decimal;
  /// Flat discount in rupees. Takes precedence over discountPercent.
  discountAmount?: Prisma.Decimal;
}

export interface LineAmounts {
  grossAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
}

/**
 * Value of one line before tax.
 *
 * Discount is applied *before* tax, which is the correct treatment for a trade
 * discount shown on the face of the invoice — tax is charged on what the
 * customer actually pays, not on the list price.
 */
export function computeLineAmounts(input: LineAmountInput): LineAmounts {
  const grossAmount = round2(input.quantity.times(input.rate));

  let discountAmount: Prisma.Decimal;
  let discountPercent: Prisma.Decimal;

  if (input.discountAmount !== undefined) {
    discountAmount = round2(input.discountAmount);
    discountPercent = grossAmount.isZero()
      ? ZERO()
      : round2(discountAmount.dividedBy(grossAmount).times(100));
  } else if (input.discountPercent !== undefined) {
    discountPercent = input.discountPercent;
    discountAmount = round2(grossAmount.times(discountPercent).dividedBy(100));
  } else {
    discountAmount = ZERO();
    discountPercent = ZERO();
  }

  return {
    grossAmount,
    discountAmount,
    discountPercent,
    taxableValue: round2(grossAmount.minus(discountAmount)),
  };
}

export interface ComputedLine extends LineAmounts, LineTax {
  lineTotal: Prisma.Decimal;
}

export function computeLine(
  amounts: LineAmountInput,
  rates: TaxRateInput,
  supplyType: SupplyType,
): ComputedLine {
  const base = computeLineAmounts(amounts);
  const tax = computeLineTax(base.taxableValue, rates, supplyType);
  const lineTotal = round2(
    base.taxableValue
      .plus(tax.cgstAmount)
      .plus(tax.sgstAmount)
      .plus(tax.igstAmount)
      .plus(tax.cessAmount),
  );
  return { ...base, ...tax, lineTotal };
}

export interface InvoiceTotals {
  subtotal: Prisma.Decimal;
  totalDiscount: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  totalCgst: Prisma.Decimal;
  totalSgst: Prisma.Decimal;
  totalIgst: Prisma.Decimal;
  totalCess: Prisma.Decimal;
  freightCharges: Prisma.Decimal;
  otherCharges: Prisma.Decimal;
  roundOff: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
}

export interface ChargeInput {
  freightCharges?: Prisma.Decimal;
  otherCharges?: Prisma.Decimal;
}

/**
 * Rolls lines up into invoice totals.
 *
 * `freightCharges` and `otherCharges` here are treated as NON-taxable
 * reimbursements added after tax. If freight is part of the supply and must
 * carry GST — which is the usual case when you arrange the transport — add it
 * as a line item against the transport HSN instead. That keeps the HSN-wise
 * summary on GSTR-1 correct, which apportioning freight across goods lines
 * would not.
 */
export function computeInvoiceTotals(
  lines: ComputedLine[],
  charges: ChargeInput = {},
): InvoiceTotals {
  const freightCharges = round2(charges.freightCharges ?? ZERO());
  const otherCharges = round2(charges.otherCharges ?? ZERO());

  const subtotal = round2(sum(lines.map((l) => l.grossAmount)));
  const totalDiscount = round2(sum(lines.map((l) => l.discountAmount)));
  const taxableValue = round2(sum(lines.map((l) => l.taxableValue)));
  const totalCgst = round2(sum(lines.map((l) => l.cgstAmount)));
  const totalSgst = round2(sum(lines.map((l) => l.sgstAmount)));
  const totalIgst = round2(sum(lines.map((l) => l.igstAmount)));
  const totalCess = round2(sum(lines.map((l) => l.cessAmount)));

  const beforeRounding = round2(
    taxableValue
      .plus(totalCgst)
      .plus(totalSgst)
      .plus(totalIgst)
      .plus(totalCess)
      .plus(freightCharges)
      .plus(otherCharges),
  );

  const grandTotal = roundToRupee(beforeRounding);
  const roundOff = round2(grandTotal.minus(beforeRounding));

  return {
    subtotal,
    totalDiscount,
    taxableValue,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    freightCharges,
    otherCharges,
    roundOff,
    grandTotal,
  };
}

export interface HsnSummaryRow {
  hsnCode: string;
  uqc: string;
  quantity: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  cessAmount: Prisma.Decimal;
}

/**
 * HSN-wise summary. Required on the invoice above the turnover threshold and
 * required on every GSTR-1 filing, so it is computed here rather than in a
 * report so both surfaces agree.
 */
export function buildHsnSummary(
  lines: Array<ComputedLine & { hsnCode: string; uqc: string; quantity: Prisma.Decimal }>,
): HsnSummaryRow[] {
  const byHsn = new Map<string, HsnSummaryRow>();

  for (const line of lines) {
    const key = `${line.hsnCode}|${line.uqc}`;
    const existing = byHsn.get(key);
    if (existing) {
      existing.quantity = existing.quantity.plus(line.quantity);
      existing.taxableValue = existing.taxableValue.plus(line.taxableValue);
      existing.cgstAmount = existing.cgstAmount.plus(line.cgstAmount);
      existing.sgstAmount = existing.sgstAmount.plus(line.sgstAmount);
      existing.igstAmount = existing.igstAmount.plus(line.igstAmount);
      existing.cessAmount = existing.cessAmount.plus(line.cessAmount);
    } else {
      byHsn.set(key, {
        hsnCode: line.hsnCode,
        uqc: line.uqc,
        quantity: D(line.quantity),
        taxableValue: D(line.taxableValue),
        cgstAmount: D(line.cgstAmount),
        sgstAmount: D(line.sgstAmount),
        igstAmount: D(line.igstAmount),
        cessAmount: D(line.cessAmount),
      });
    }
  }

  return [...byHsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode));
}

/**
 * Truncate the HSN to the number of digits the business is required to report
 * (4 below ₹5 crore turnover, 6 above).
 */
export const formatHsn = (code: string, digits: number): string => code.slice(0, digits);
