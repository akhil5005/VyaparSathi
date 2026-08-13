import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, integerToWords } from './amountInWords.js';
import { financialYearOf } from '../../lib/financialYear.js';

describe('integerToWords (Indian grouping)', () => {
  const cases: [number, string][] = [
    [0, 'Zero'],
    [7, 'Seven'],
    [15, 'Fifteen'],
    [40, 'Forty'],
    [99, 'Ninety Nine'],
    [100, 'One Hundred'],
    [240, 'Two Hundred Forty'],
    [2688, 'Two Thousand Six Hundred Eighty Eight'],
    [10_000, 'Ten Thousand'],
    // Lakh, not "hundred thousand" — this is the point of the function.
    [100_000, 'One Lakh'],
    [250_000, 'Two Lakh Fifty Thousand'],
    [1_234_567, 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven'],
    [10_000_000, 'One Crore'],
    [12_34_56_789, 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(integerToWords(input), expected);
    });
  }
});

describe('amountInWords', () => {
  it('formats a whole-rupee invoice total', () => {
    assert.equal(amountInWords(2688), 'Rupees Two Thousand Six Hundred Eighty Eight Only');
  });

  it('includes paise when present', () => {
    assert.equal(amountInWords('1500.50'), 'Rupees One Thousand Five Hundred and Fifty Paise Only');
  });

  it('handles a single paisa', () => {
    assert.equal(amountInWords('10.01'), 'Rupees Ten and One Paise Only');
  });

  it('handles zero', () => {
    assert.equal(amountInWords(0), 'Rupees Zero Only');
  });

  it('handles a credit note (negative) amount', () => {
    assert.equal(amountInWords(-500), 'Minus Rupees Five Hundred Only');
  });
});

describe('financialYearOf', () => {
  it('rolls over on 1 April, not 1 January', () => {
    assert.equal(financialYearOf(new Date('2026-03-31T00:00:00Z')), '2025-26');
    assert.equal(financialYearOf(new Date('2026-04-01T00:00:00Z')), '2026-27');
    assert.equal(financialYearOf(new Date('2026-12-31T00:00:00Z')), '2026-27');
    assert.equal(financialYearOf(new Date('2027-01-01T00:00:00Z')), '2026-27');
  });

  it('pads the second year to two digits across a century boundary', () => {
    assert.equal(financialYearOf(new Date('2099-05-01T00:00:00Z')), '2099-00');
  });
});
