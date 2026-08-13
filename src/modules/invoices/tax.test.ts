/**
 * The tax arithmetic is the part of this app that is legally wrong if it is
 * numerically wrong. Every case here is a real invoice shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../lib/money.js';
import {
  buildHsnSummary,
  computeInvoiceTotals,
  computeLine,
  computeLineAmounts,
  computeLineTax,
  formatHsn,
} from './tax.js';

const rates = (gst: number, cess = 0) => ({ gstRate: D(gst), cessRate: D(cess) });

describe('computeLineTax', () => {
  it('splits into CGST + SGST for an intra-state supply', () => {
    const tax = computeLineTax(D(1000), rates(12), 'INTRA_STATE');
    assert.equal(tax.cgstRate.toString(), '6');
    assert.equal(tax.cgstAmount.toString(), '60');
    assert.equal(tax.sgstRate.toString(), '6');
    assert.equal(tax.sgstAmount.toString(), '60');
    assert.equal(tax.igstAmount.toString(), '0');
  });

  it('charges the whole rate as IGST for an inter-state supply', () => {
    const tax = computeLineTax(D(1000), rates(12), 'INTER_STATE');
    assert.equal(tax.igstRate.toString(), '12');
    assert.equal(tax.igstAmount.toString(), '120');
    assert.equal(tax.cgstAmount.toString(), '0');
    assert.equal(tax.sgstAmount.toString(), '0');
  });

  it('never charges both CGST/SGST and IGST', () => {
    for (const supply of ['INTRA_STATE', 'INTER_STATE'] as const) {
      const tax = computeLineTax(D(2400), rates(18), supply);
      const splitCharged = tax.cgstAmount.plus(tax.sgstAmount).greaterThan(0);
      const igstCharged = tax.igstAmount.greaterThan(0);
      assert.ok(splitCharged !== igstCharged, `${supply} charged both or neither`);
    }
  });

  it('applies cess on top of GST', () => {
    const tax = computeLineTax(D(1000), rates(18, 5), 'INTER_STATE');
    assert.equal(tax.igstAmount.toString(), '180');
    assert.equal(tax.cessAmount.toString(), '50');
  });

  it('rounds each half independently on an odd amount', () => {
    // 1234.55 @ 5% -> 2.5% each = 30.86375 -> 30.86
    const tax = computeLineTax(D('1234.55'), rates(5), 'INTRA_STATE');
    assert.equal(tax.cgstAmount.toString(), '30.86');
    assert.equal(tax.sgstAmount.toString(), '30.86');
  });
});

describe('computeLineAmounts', () => {
  it('computes gross from quantity x rate', () => {
    const line = computeLineAmounts({ quantity: D(10), rate: D(240) });
    assert.equal(line.grossAmount.toString(), '2400');
    assert.equal(line.taxableValue.toString(), '2400');
    assert.equal(line.discountAmount.toString(), '0');
  });

  it('handles a fractional quantity (half a ream)', () => {
    const line = computeLineAmounts({ quantity: D('3.5'), rate: D(240) });
    assert.equal(line.grossAmount.toString(), '840');
  });

  it('applies a percentage discount before tax', () => {
    const line = computeLineAmounts({ quantity: D(10), rate: D(240), discountPercent: D(10) });
    assert.equal(line.discountAmount.toString(), '240');
    assert.equal(line.taxableValue.toString(), '2160');
  });

  it('applies a flat discount and back-computes the percent', () => {
    const line = computeLineAmounts({ quantity: D(10), rate: D(240), discountAmount: D(400) });
    assert.equal(line.taxableValue.toString(), '2000');
    assert.equal(line.discountPercent.toString(), '16.67');
  });

  it('does not divide by zero on a free line', () => {
    const line = computeLineAmounts({ quantity: D(1), rate: D(0), discountAmount: D(0) });
    assert.equal(line.discountPercent.toString(), '0');
  });
});

describe('computeInvoiceTotals', () => {
  it('totals a simple intra-state (Punjab) invoice', () => {
    // 10 reams A4 @ 240, 12% GST, customer in Punjab
    const line = computeLine({ quantity: D(10), rate: D(240) }, rates(12), 'INTRA_STATE');
    const totals = computeInvoiceTotals([line]);

    assert.equal(totals.taxableValue.toString(), '2400');
    assert.equal(totals.totalCgst.toString(), '144');
    assert.equal(totals.totalSgst.toString(), '144');
    assert.equal(totals.totalIgst.toString(), '0');
    assert.equal(totals.grandTotal.toString(), '2688');
    assert.equal(totals.roundOff.toString(), '0');
  });

  it('totals the same invoice sold outside Punjab as IGST', () => {
    const line = computeLine({ quantity: D(10), rate: D(240) }, rates(12), 'INTER_STATE');
    const totals = computeInvoiceTotals([line]);

    assert.equal(totals.totalIgst.toString(), '288');
    assert.equal(totals.totalCgst.toString(), '0');
    // Same money either way — only the tax heads differ.
    assert.equal(totals.grandTotal.toString(), '2688');
  });

  it('produces a round-off line when the total has paise', () => {
    // 3 x 333.33 = 999.99 @ 12% -> 1119.99 -> rounds to 1120
    const line = computeLine({ quantity: D(3), rate: D('333.33') }, rates(12), 'INTRA_STATE');
    const totals = computeInvoiceTotals([line]);

    assert.equal(totals.taxableValue.toString(), '999.99');
    assert.equal(totals.grandTotal.toString(), '1120');
    assert.equal(totals.roundOff.toString(), '0.01');
  });

  it('rounds down and reports a negative round-off', () => {
    // 1 x 1000.20 @ 0% -> 1000.20 -> rounds to 1000
    const line = computeLine({ quantity: D(1), rate: D('1000.20') }, rates(0), 'INTRA_STATE');
    const totals = computeInvoiceTotals([line]);

    assert.equal(totals.grandTotal.toString(), '1000');
    assert.equal(totals.roundOff.toString(), '-0.2');
  });

  it('adds freight after tax as a non-taxable reimbursement', () => {
    const line = computeLine({ quantity: D(10), rate: D(240) }, rates(12), 'INTRA_STATE');
    const totals = computeInvoiceTotals([line], { freightCharges: D(150) });

    // Tax is unchanged — freight did not enter the taxable value.
    assert.equal(totals.totalCgst.toString(), '144');
    assert.equal(totals.grandTotal.toString(), '2838');
  });

  it('grand total always equals taxable + taxes + charges + roundoff', () => {
    const lines = [
      computeLine({ quantity: D(7), rate: D('123.45'), discountPercent: D(3) }, rates(18), 'INTRA_STATE'),
      computeLine({ quantity: D('2.5'), rate: D('987.65') }, rates(18), 'INTRA_STATE'),
      computeLine({ quantity: D(1), rate: D('0.99') }, rates(5), 'INTRA_STATE'),
    ];
    const t = computeInvoiceTotals(lines, { freightCharges: D('75.50'), otherCharges: D('10.10') });

    const reconstructed = t.taxableValue
      .plus(t.totalCgst)
      .plus(t.totalSgst)
      .plus(t.totalIgst)
      .plus(t.totalCess)
      .plus(t.freightCharges)
      .plus(t.otherCharges)
      .plus(t.roundOff);

    assert.equal(reconstructed.toString(), t.grandTotal.toString());
  });

  it('grand total is always a whole rupee', () => {
    for (const rate of ['0.33', '1.11', '99.99', '1234.567']) {
      const line = computeLine({ quantity: D(3), rate: D(rate) }, rates(12), 'INTRA_STATE');
      const totals = computeInvoiceTotals([line]);
      assert.ok(totals.grandTotal.modulo(1).isZero(), `${rate} produced ${totals.grandTotal}`);
    }
  });

  it('subtotal minus discount equals taxable value', () => {
    const lines = [
      computeLine({ quantity: D(10), rate: D(240), discountPercent: D(10) }, rates(12), 'INTRA_STATE'),
      computeLine({ quantity: D(5), rate: D(500), discountAmount: D(250) }, rates(12), 'INTRA_STATE'),
    ];
    const t = computeInvoiceTotals(lines);
    assert.equal(t.subtotal.minus(t.totalDiscount).toString(), t.taxableValue.toString());
  });
});

describe('buildHsnSummary', () => {
  it('groups lines by HSN and sums them', () => {
    const mk = (hsn: string, qty: number, rate: number) => ({
      ...computeLine({ quantity: D(qty), rate: D(rate) }, rates(12), 'INTRA_STATE'),
      hsnCode: hsn,
      uqc: 'NOS',
      quantity: D(qty),
    });

    const summary = buildHsnSummary([mk('4802', 10, 240), mk('4802', 5, 200), mk('4810', 2, 500)]);

    assert.equal(summary.length, 2);
    assert.equal(summary[0]!.hsnCode, '4802');
    assert.equal(summary[0]!.quantity.toString(), '15');
    assert.equal(summary[0]!.taxableValue.toString(), '3400');
    assert.equal(summary[1]!.hsnCode, '4810');
    assert.equal(summary[1]!.taxableValue.toString(), '1000');
  });

  it('keeps different units of the same HSN as separate rows', () => {
    const mk = (uqc: string) => ({
      ...computeLine({ quantity: D(1), rate: D(100) }, rates(12), 'INTRA_STATE'),
      hsnCode: '4802',
      uqc,
      quantity: D(1),
    });
    assert.equal(buildHsnSummary([mk('NOS'), mk('KGS')]).length, 2);
  });
});

describe('formatHsn', () => {
  it('truncates to the digits the business must report', () => {
    assert.equal(formatHsn('48025500', 4), '4802');
    assert.equal(formatHsn('48025500', 6), '480255');
  });
});
