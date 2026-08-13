import { Prisma } from '@prisma/client';
import { D, round2, ZERO } from '../../lib/money.js';

/**
 * Input-tax-credit set-off — how much GST actually leaves the bank account.
 *
 * Output tax collected on sales is reduced by input credit paid on purchases,
 * but the heads are not freely interchangeable. The rules (CGST Act s.49, 49A):
 *
 *   1. IGST credit is used first — against IGST, then CGST, then SGST.
 *   2. CGST credit covers CGST, then any IGST left over.
 *   3. SGST credit covers SGST, then any IGST left over.
 *   4. **CGST credit can never pay SGST, and SGST can never pay CGST.**
 *   5. Cess is ring-fenced: cess credit pays cess only.
 *
 * Rule 4 is the one that surprises people, and it is why a business can be
 * sitting on unused credit and still have to pay cash.
 *
 * This is an indicative computation for planning, not a filing. Reversals,
 * blocked credits and the rules around provisional credit all sit outside it —
 * the return your CA files is the authority.
 */

export interface TaxHeads {
  cgst: Prisma.Decimal;
  sgst: Prisma.Decimal;
  igst: Prisma.Decimal;
  cess: Prisma.Decimal;
}

export const zeroHeads = (): TaxHeads => ({
  cgst: ZERO(),
  sgst: ZERO(),
  igst: ZERO(),
  cess: ZERO(),
});

export const headsFrom = (
  cgst: Prisma.Decimal.Value,
  sgst: Prisma.Decimal.Value,
  igst: Prisma.Decimal.Value,
  cess: Prisma.Decimal.Value = 0,
): TaxHeads => ({ cgst: D(cgst), sgst: D(sgst), igst: D(igst), cess: D(cess) });

export const totalHeads = (heads: TaxHeads): Prisma.Decimal =>
  round2(heads.cgst.plus(heads.sgst).plus(heads.igst).plus(heads.cess));

/// Applies as much credit as the liability can absorb; returns what each side
/// has left.
function apply(
  liability: Prisma.Decimal,
  credit: Prisma.Decimal,
): { used: Prisma.Decimal; liabilityLeft: Prisma.Decimal; creditLeft: Prisma.Decimal } {
  const used = liability.lessThan(credit) ? liability : credit;
  return {
    used: round2(used),
    liabilityLeft: round2(liability.minus(used)),
    creditLeft: round2(credit.minus(used)),
  };
}

export interface SetOffResult {
  outputTax: TaxHeads;
  inputCredit: TaxHeads;
  /// Credit actually consumed this period, by the head it came from.
  creditUtilised: TaxHeads;
  /// What has to be paid in cash, by head.
  cashPayable: TaxHeads;
  /// Unused credit that rolls into the next period.
  creditCarriedForward: TaxHeads;
  totalCashPayable: Prisma.Decimal;
  totalCarriedForward: Prisma.Decimal;
}

export function computeSetOff(outputTax: TaxHeads, inputCredit: TaxHeads): SetOffResult {
  let liabCgst = round2(outputTax.cgst);
  let liabSgst = round2(outputTax.sgst);
  let liabIgst = round2(outputTax.igst);
  let liabCess = round2(outputTax.cess);

  let credCgst = round2(inputCredit.cgst);
  let credSgst = round2(inputCredit.sgst);
  let credIgst = round2(inputCredit.igst);
  let credCess = round2(inputCredit.cess);

  const usedFrom = zeroHeads();

  // 1. IGST credit: IGST liability first, then CGST, then SGST.
  let step = apply(liabIgst, credIgst);
  liabIgst = step.liabilityLeft;
  credIgst = step.creditLeft;
  usedFrom.igst = usedFrom.igst.plus(step.used);

  step = apply(liabCgst, credIgst);
  liabCgst = step.liabilityLeft;
  credIgst = step.creditLeft;
  usedFrom.igst = usedFrom.igst.plus(step.used);

  step = apply(liabSgst, credIgst);
  liabSgst = step.liabilityLeft;
  credIgst = step.creditLeft;
  usedFrom.igst = usedFrom.igst.plus(step.used);

  // 2. CGST credit: CGST liability, then whatever IGST is left. Never SGST.
  step = apply(liabCgst, credCgst);
  liabCgst = step.liabilityLeft;
  credCgst = step.creditLeft;
  usedFrom.cgst = usedFrom.cgst.plus(step.used);

  step = apply(liabIgst, credCgst);
  liabIgst = step.liabilityLeft;
  credCgst = step.creditLeft;
  usedFrom.cgst = usedFrom.cgst.plus(step.used);

  // 3. SGST credit: SGST liability, then whatever IGST is left. Never CGST.
  step = apply(liabSgst, credSgst);
  liabSgst = step.liabilityLeft;
  credSgst = step.creditLeft;
  usedFrom.sgst = usedFrom.sgst.plus(step.used);

  step = apply(liabIgst, credSgst);
  liabIgst = step.liabilityLeft;
  credSgst = step.creditLeft;
  usedFrom.sgst = usedFrom.sgst.plus(step.used);

  // 4. Cess is ring-fenced.
  step = apply(liabCess, credCess);
  liabCess = step.liabilityLeft;
  credCess = step.creditLeft;
  usedFrom.cess = usedFrom.cess.plus(step.used);

  const cashPayable = headsFrom(liabCgst, liabSgst, liabIgst, liabCess);
  const creditCarriedForward = headsFrom(credCgst, credSgst, credIgst, credCess);

  return {
    outputTax,
    inputCredit,
    creditUtilised: {
      cgst: round2(usedFrom.cgst),
      sgst: round2(usedFrom.sgst),
      igst: round2(usedFrom.igst),
      cess: round2(usedFrom.cess),
    },
    cashPayable,
    creditCarriedForward,
    totalCashPayable: totalHeads(cashPayable),
    totalCarriedForward: totalHeads(creditCarriedForward),
  };
}

/** "2026-07" → the first and last instant of that month. */
export function periodRange(period: string): { fromDate: Date; toDate: Date } {
  const [yearPart, monthPart] = period.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid period "${period}" — expected YYYY-MM`);
  }
  return {
    fromDate: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    toDate: new Date(Date.UTC(year, month, 1, 0, 0, 0, -1)),
  };
}
