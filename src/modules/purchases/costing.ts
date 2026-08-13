import { Prisma } from '@prisma/client';
import { D, round2, round4, sum, ZERO } from '../../lib/money.js';

/**
 * Inventory costing — pure arithmetic, no database.
 *
 * This decides what your stock is worth and what margin each sale made. It is
 * wrong-but-silent territory: a bad cost never throws, it just makes every
 * profit figure downstream a lie. Hence the test suite.
 */

/**
 * Moving weighted-average cost after a receipt.
 *
 *     newAvg = (onHand × oldAvg + received × receivedRate) ÷ (onHand + received)
 *
 * Two cases the formula alone doesn't cover:
 *
 *  - **Stock is at or below zero.** He bills before entering the purchase, so
 *    negative stock is normal here. Averaging against a negative quantity gives
 *    nonsense, so the incoming rate simply becomes the new average.
 *  - **The result would be zero quantity.** Nothing to average; keep the old
 *    figure so the next receipt has a sensible starting point.
 */
export function movingAverageCost(
  onHand: Prisma.Decimal.Value,
  currentAverage: Prisma.Decimal.Value,
  received: Prisma.Decimal.Value,
  receivedRate: Prisma.Decimal.Value,
): Prisma.Decimal {
  const qty = D(onHand);
  const avg = D(currentAverage);
  const inQty = D(received);
  const inRate = D(receivedRate);

  if (inQty.lessThanOrEqualTo(0)) return round4(avg);
  if (qty.lessThanOrEqualTo(0)) return round4(inRate);

  const total = qty.plus(inQty);
  if (total.isZero()) return round4(avg);

  return round4(qty.times(avg).plus(inQty.times(inRate)).dividedBy(total));
}

/**
 * Splits freight and other charges across lines in proportion to their value.
 *
 * The residual from rounding is pushed onto the largest line rather than being
 * dropped, so the shares always add back to exactly the charge. A missing paisa
 * here becomes a stock valuation that doesn't tie to the purchase ledger.
 */
export function apportionCharges(
  charges: Prisma.Decimal.Value,
  lineValues: Prisma.Decimal.Value[],
): Prisma.Decimal[] {
  const total = round2(charges);
  if (lineValues.length === 0) return [];
  if (total.isZero()) return lineValues.map(() => ZERO());

  const values = lineValues.map((v) => D(v));
  const basis = sum(values);

  // Every line is worth zero (a fully discounted bill) — split evenly instead
  // of dividing by zero.
  if (basis.lessThanOrEqualTo(0)) {
    const even = round2(total.dividedBy(values.length));
    const shares = values.map(() => even);
    const drift = round2(total.minus(sum(shares)));
    if (!drift.isZero() && shares.length > 0) shares[0] = round2(shares[0]!.plus(drift));
    return shares;
  }

  const shares = values.map((v) => round2(total.times(v).dividedBy(basis)));

  const residual = round2(total.minus(sum(shares)));
  if (!residual.isZero()) {
    let largest = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i]!.greaterThan(values[largest]!)) largest = i;
    }
    shares[largest] = round2(shares[largest]!.plus(residual));
  }

  return shares;
}

export interface LandedCostInput {
  /// Line value after discount, before tax.
  taxableValue: Prisma.Decimal;
  /// This line's slice of freight and other charges.
  chargeShare: Prisma.Decimal;
  /// CGST + SGST + IGST + cess on this line.
  taxAmount: Prisma.Decimal;
  /// Quantity in the product's base unit.
  baseQuantity: Prisma.Decimal;
  /// When the credit is claimable the tax is recovered, so it is not a cost.
  itcEligible: boolean;
}

/**
 * What one base unit of this line actually cost to put on the shelf.
 *
 * GST is excluded when the input credit is claimable — you get that money back,
 * so treating it as cost would understate every margin. When the credit is
 * *not* available (blocked credit, an unregistered supplier, composition
 * scheme) the tax is a real cost and is included. Getting this backwards is one
 * of the more common bookkeeping errors in a small trading business.
 */
export function landedCostPerBaseUnit(input: LandedCostInput): Prisma.Decimal {
  if (input.baseQuantity.lessThanOrEqualTo(0)) return ZERO();

  const cost = input.itcEligible
    ? input.taxableValue.plus(input.chargeShare)
    : input.taxableValue.plus(input.chargeShare).plus(input.taxAmount);

  return round4(cost.dividedBy(input.baseQuantity));
}

/**
 * Compares what we computed against the total printed on the supplier's bill.
 *
 * A mismatch is not an error — suppliers round differently, and some add
 * charges we haven't modelled. It is a prompt to look at the paper before
 * filing, which is far better than silently claiming credit for a figure that
 * won't match their GSTR-1.
 */
export function reconcileWithSupplierTotal(
  computedTotal: Prisma.Decimal,
  supplierTotal: Prisma.Decimal.Value | undefined,
  tolerance: Prisma.Decimal.Value = 1,
): { matches: boolean; difference: Prisma.Decimal } | null {
  if (supplierTotal === undefined) return null;
  const difference = round2(D(supplierTotal).minus(computedTotal));
  return { matches: difference.abs().lessThanOrEqualTo(D(tolerance)), difference };
}
