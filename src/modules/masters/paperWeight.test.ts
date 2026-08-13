/**
 * The kg↔ream factor is the number that decides whether a bill in reams
 * reconciles against a purchase in kilograms. Getting it wrong makes stock
 * drift silently, so the arithmetic is pinned here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { grossWeightKg, kgToBaseUnitFactor, parseSheetSize, reamWeightKg } from './paperWeight.js';

describe('parseSheetSize', () => {
  it('reads ISO A-series names', () => {
    const a4 = parseSheetSize('A4')!;
    assert.equal(a4.widthMm, 210);
    assert.equal(a4.heightMm, 297);
    // areaM2 is binary floating point (0.21 * 0.297), so compare with tolerance
    // rather than exact equality — it is only ever an intermediate value.
    assert.ok(Math.abs(a4.areaM2 - 0.06237) < 1e-9, `got ${a4.areaM2}`);
    assert.equal(parseSheetSize('a3')!.widthMm, 297);
    assert.equal(parseSheetSize('A0')!.heightMm, 1189);
  });

  it('reads ISO B-series names', () => {
    assert.equal(parseSheetSize('B5')!.widthMm, 176);
  });

  it('reads explicit metric sizes', () => {
    assert.equal(parseSheetSize('210x297mm')!.widthMm, 210);
    assert.equal(parseSheetSize('70x100cm')!.widthMm, 700);
  });

  it('treats bare numbers as inches — the Indian paper-trade convention', () => {
    // 23x36 inches is a standard mill size; reading it as mm would be absurd.
    const size = parseSheetSize('23x36')!;
    assert.equal(Math.round(size.widthMm), 584);
    assert.equal(Math.round(size.heightMm), 914);
  });

  it('accepts an explicit inch suffix and the x/× separators', () => {
    assert.equal(parseSheetSize('23x36in')!.widthMm, parseSheetSize('23x36')!.widthMm);
    assert.equal(parseSheetSize('23×36')!.widthMm, parseSheetSize('23x36')!.widthMm);
  });

  it('returns null for junk rather than guessing', () => {
    assert.equal(parseSheetSize(''), null);
    assert.equal(parseSheetSize('big'), null);
    assert.equal(parseSheetSize('A99'), null);
    assert.equal(parseSheetSize('0x10'), null);
  });
});

describe('reamWeightKg', () => {
  it('computes the weight of a 75gsm A4 ream of 500 sheets', () => {
    // 75 g/m² x 0.06237 m² x 500 / 1000 = 2.3389 kg
    const weight = reamWeightKg({ gsm: 75, sheetSize: 'A4', sheetsPerReam: 500 });
    assert.equal(weight!.toString(), '2.3389');
  });

  it('scales linearly with gsm', () => {
    const a = reamWeightKg({ gsm: 70, sheetSize: 'A4', sheetsPerReam: 500 })!;
    const b = reamWeightKg({ gsm: 140, sheetSize: 'A4', sheetsPerReam: 500 })!;
    assert.equal(b.dividedBy(a).toDecimalPlaces(4).toString(), '2');
  });

  it('computes a mill-size ream (23x36in, 70gsm)', () => {
    const weight = reamWeightKg({ gsm: 70, sheetSize: '23x36', sheetsPerReam: 500 })!;
    // ~18.7 kg — a realistic ream weight for that size.
    assert.ok(weight.greaterThan(18) && weight.lessThan(19), `got ${weight}`);
  });

  it('returns null when the spec is incomplete', () => {
    assert.equal(reamWeightKg({ gsm: 75, sheetsPerReam: 500 }), null);
    assert.equal(reamWeightKg({ sheetSize: 'A4', sheetsPerReam: 500 }), null);
    assert.equal(reamWeightKg({ gsm: 75, sheetSize: 'A4' }), null);
    assert.equal(reamWeightKg({}), null);
  });

  it('returns null for a nonsense sheet size instead of throwing', () => {
    assert.equal(reamWeightKg({ gsm: 75, sheetSize: 'medium', sheetsPerReam: 500 }), null);
  });

  it('rejects non-positive inputs', () => {
    assert.equal(reamWeightKg({ gsm: 0, sheetSize: 'A4', sheetsPerReam: 500 }), null);
    assert.equal(reamWeightKg({ gsm: 75, sheetSize: 'A4', sheetsPerReam: -1 }), null);
  });
});

describe('kgToBaseUnitFactor', () => {
  it('inverts the ream weight', () => {
    // 1 / 2.3389 = 0.42755... -> 0.4276 at 4dp
    const weight = reamWeightKg({ gsm: 75, sheetSize: 'A4', sheetsPerReam: 500 })!;
    assert.equal(kgToBaseUnitFactor(weight)!.toString(), '0.4276');
  });

  it('round-trips within rounding tolerance', () => {
    // 100 kg -> reams -> kg lands back near 100. Both the weight and the factor
    // are stored at 4dp, so ~0.01% drift over 100 units is expected and fine —
    // stock is reconciled in base units, not by replaying conversions.
    const weight = reamWeightKg({ gsm: 75, sheetSize: 'A4', sheetsPerReam: 500 })!;
    const factor = kgToBaseUnitFactor(weight)!;
    const backToKg = factor.times(100).times(weight);
    assert.ok(backToKg.minus(100).abs().lessThan(0.05), `got ${backToKg}`);
  });

  it('refuses a zero or negative weight', () => {
    assert.equal(kgToBaseUnitFactor(0), null);
    assert.equal(kgToBaseUnitFactor(-1), null);
  });
});

describe('grossWeightKg', () => {
  it('computes the e-way bill weight for a quantity of reams', () => {
    const weight = reamWeightKg({ gsm: 75, sheetSize: 'A4', sheetsPerReam: 500 })!;
    assert.equal(grossWeightKg(10, weight)!.toString(), '23.389');
  });

  it('is null when the product has no weight on record', () => {
    assert.equal(grossWeightKg(10, null), null);
  });
});
