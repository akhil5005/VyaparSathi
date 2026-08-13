/**
 * Costing decides what stock is worth and what every sale earned. A wrong cost
 * never throws — it just makes each margin figure downstream a quiet lie.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../lib/money.js';
import { sum } from '../../lib/money.js';
import {
  apportionCharges,
  landedCostPerBaseUnit,
  movingAverageCost,
  reconcileWithSupplierTotal,
} from './costing.js';
import { computeSetOff, headsFrom, periodRange, totalHeads, zeroHeads } from './gstSetOff.js';

describe('movingAverageCost', () => {
  it('blends the old average with the new receipt', () => {
    // 100 @ 200 + 100 @ 240 -> 220
    assert.equal(movingAverageCost(100, 200, 100, 240).toString(), '220');
  });

  it('weights by quantity, not by count', () => {
    // 900 @ 100 + 100 @ 200 -> 110
    assert.equal(movingAverageCost(900, 100, 100, 200).toString(), '110');
  });

  it('takes the incoming rate when there is no stock', () => {
    assert.equal(movingAverageCost(0, 0, 50, 237).toString(), '237');
  });

  it('takes the incoming rate when stock is negative', () => {
    // He bills before entering the purchase, so this is a normal Monday.
    // Averaging against -20 would produce nonsense.
    assert.equal(movingAverageCost(-20, 200, 100, 250).toString(), '250');
  });

  it('ignores a zero or negative receipt', () => {
    assert.equal(movingAverageCost(100, 200, 0, 999).toString(), '200');
    assert.equal(movingAverageCost(100, 200, -5, 999).toString(), '200');
  });

  it('keeps four decimal places of precision', () => {
    const avg = movingAverageCost(3, '2.3389', 7, '2.5');
    assert.equal(avg.toString(), '2.4517');
  });

  it('stays between the two rates it blends', () => {
    for (const qty of [1, 10, 500]) {
      const avg = movingAverageCost(qty, 100, qty, 300);
      assert.ok(avg.greaterThanOrEqualTo(100) && avg.lessThanOrEqualTo(300));
    }
  });
});

describe('apportionCharges', () => {
  it('splits in proportion to line value', () => {
    const shares = apportionCharges(300, [1000, 2000]);
    assert.equal(shares[0]!.toString(), '100');
    assert.equal(shares[1]!.toString(), '200');
  });

  it('always adds back to exactly the charge', () => {
    // 100 / 3 does not divide evenly; the residual must not be dropped.
    const shares = apportionCharges(100, [1, 1, 1]);
    assert.equal(sum(shares).toString(), '100');
  });

  it('pushes the rounding residual onto the largest line', () => {
    const shares = apportionCharges(10, [1, 1, 98]);
    assert.equal(sum(shares).toString(), '10');
    // The big line absorbs the leftover paise rather than a trivial one.
    assert.ok(shares[2]!.greaterThan(shares[0]!));
  });

  it('returns zeros when there is nothing to apportion', () => {
    const shares = apportionCharges(0, [100, 200]);
    assert.equal(shares.length, 2);
    assert.equal(sum(shares).toString(), '0');
  });

  it('splits evenly rather than dividing by zero on a fully discounted bill', () => {
    const shares = apportionCharges(90, [0, 0, 0]);
    assert.equal(sum(shares).toString(), '90');
    assert.equal(shares[1]!.toString(), '30');
  });

  it('handles a single line', () => {
    assert.equal(apportionCharges(500, [1234])[0]!.toString(), '500');
  });

  it('handles no lines', () => {
    assert.deepEqual(apportionCharges(500, []), []);
  });
});

describe('landedCostPerBaseUnit', () => {
  const base = {
    taxableValue: D(2000),
    chargeShare: D(200),
    taxAmount: D(240),
    baseQuantity: D(10),
  };

  it('excludes GST when the input credit is claimable', () => {
    // The tax comes back, so treating it as cost would understate every margin.
    const cost = landedCostPerBaseUnit({ ...base, itcEligible: true });
    assert.equal(cost.toString(), '220'); // (2000 + 200) / 10
  });

  it('includes GST when the credit is not available', () => {
    // Blocked credit or an unregistered supplier — the tax is a real cost.
    const cost = landedCostPerBaseUnit({ ...base, itcEligible: false });
    assert.equal(cost.toString(), '244'); // (2000 + 200 + 240) / 10
  });

  it('includes the freight share', () => {
    const withFreight = landedCostPerBaseUnit({ ...base, itcEligible: true });
    const withoutFreight = landedCostPerBaseUnit({ ...base, chargeShare: D(0), itcEligible: true });
    assert.ok(withFreight.greaterThan(withoutFreight));
  });

  it('returns zero rather than dividing by zero', () => {
    assert.equal(landedCostPerBaseUnit({ ...base, baseQuantity: D(0), itcEligible: true }).toString(), '0');
  });
});

describe('reconcileWithSupplierTotal', () => {
  it('is null when no supplier total was typed in', () => {
    assert.equal(reconcileWithSupplierTotal(D(1000), undefined), null);
  });

  it('accepts a rupee of rounding difference', () => {
    const result = reconcileWithSupplierTotal(D(1000), 1001)!;
    assert.equal(result.matches, true);
    assert.equal(result.difference.toString(), '1');
  });

  it('flags a real mismatch', () => {
    const result = reconcileWithSupplierTotal(D(1000), 1150)!;
    assert.equal(result.matches, false);
    assert.equal(result.difference.toString(), '150');
  });

  it('reports a negative difference when we computed more than the bill', () => {
    assert.equal(reconcileWithSupplierTotal(D(1000), 900)!.difference.toString(), '-100');
  });
});

describe('computeSetOff', () => {
  it('offsets like against like', () => {
    const result = computeSetOff(headsFrom(500, 500, 0), headsFrom(300, 300, 0));
    assert.equal(result.cashPayable.cgst.toString(), '200');
    assert.equal(result.cashPayable.sgst.toString(), '200');
    assert.equal(result.totalCashPayable.toString(), '400');
  });

  it('uses IGST credit first, spilling into CGST then SGST', () => {
    // 1000 IGST credit against 300/300 CGST/SGST liability, no IGST liability.
    const result = computeSetOff(headsFrom(300, 300, 0), headsFrom(0, 0, 1000));
    assert.equal(result.totalCashPayable.toString(), '0');
    assert.equal(result.creditCarriedForward.igst.toString(), '400');
  });

  it('never lets CGST credit pay SGST', () => {
    // The rule that surprises people: sitting on credit and still paying cash.
    const result = computeSetOff(headsFrom(0, 500, 0), headsFrom(500, 0, 0));
    assert.equal(result.cashPayable.sgst.toString(), '500');
    assert.equal(result.creditCarriedForward.cgst.toString(), '500');
    assert.equal(result.totalCashPayable.toString(), '500');
  });

  it('never lets SGST credit pay CGST', () => {
    const result = computeSetOff(headsFrom(500, 0, 0), headsFrom(0, 500, 0));
    assert.equal(result.cashPayable.cgst.toString(), '500');
    assert.equal(result.creditCarriedForward.sgst.toString(), '500');
  });

  it('lets leftover CGST and SGST credit pay IGST', () => {
    const result = computeSetOff(headsFrom(0, 0, 400), headsFrom(300, 300, 0));
    assert.equal(result.cashPayable.igst.toString(), '0');
    // 400 IGST paid: 300 from CGST credit, 100 from SGST credit.
    assert.equal(result.creditCarriedForward.sgst.toString(), '200');
    assert.equal(result.creditCarriedForward.cgst.toString(), '0');
  });

  it('ring-fences cess', () => {
    const result = computeSetOff(headsFrom(0, 0, 0, 100), headsFrom(500, 500, 500, 0));
    assert.equal(result.cashPayable.cess.toString(), '100');
  });

  it('carries everything forward when there is no liability', () => {
    const result = computeSetOff(zeroHeads(), headsFrom(100, 100, 100));
    assert.equal(result.totalCashPayable.toString(), '0');
    assert.equal(result.totalCarriedForward.toString(), '300');
  });

  it('pays everything in cash when there is no credit', () => {
    const result = computeSetOff(headsFrom(100, 100, 0), zeroHeads());
    assert.equal(result.totalCashPayable.toString(), '200');
  });

  it('conserves money: output = credit used + cash paid', () => {
    const output = headsFrom(750, 750, 1200, 50);
    const input = headsFrom(400, 900, 300, 20);
    const result = computeSetOff(output, input);

    assert.equal(
      totalHeads(result.creditUtilised).plus(result.totalCashPayable).toString(),
      totalHeads(output).toString(),
    );
  });

  it('conserves credit: input = credit used + carried forward', () => {
    const output = headsFrom(750, 750, 1200, 50);
    const input = headsFrom(400, 900, 300, 20);
    const result = computeSetOff(output, input);

    assert.equal(
      totalHeads(result.creditUtilised).plus(result.totalCarriedForward).toString(),
      totalHeads(input).toString(),
    );
  });
});

describe('periodRange', () => {
  it('spans a whole month', () => {
    const { fromDate, toDate } = periodRange('2026-07');
    assert.equal(fromDate.toISOString(), '2026-07-01T00:00:00.000Z');
    assert.equal(toDate.toISOString(), '2026-07-31T23:59:59.999Z');
  });

  it('handles February in a leap year', () => {
    assert.equal(periodRange('2028-02').toDate.toISOString(), '2028-02-29T23:59:59.999Z');
  });

  it('handles December without rolling the year wrong', () => {
    const { fromDate, toDate } = periodRange('2026-12');
    assert.equal(fromDate.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(toDate.toISOString(), '2026-12-31T23:59:59.999Z');
  });

  it('rejects a malformed period', () => {
    assert.throws(() => periodRange('2026-13'));
    assert.throws(() => periodRange('nonsense'));
  });
});
