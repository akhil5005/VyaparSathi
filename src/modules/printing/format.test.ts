import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  centre,
  columns,
  divider,
  formatCurrency,
  formatDate,
  formatIndianNumber,
  formatPercent,
  formatQuantity,
  labelValue,
  padLeft,
  padRight,
  truncate,
  wrap,
} from './format.js';

describe('formatIndianNumber', () => {
  const cases: [Prisma.Decimal.Value, string][] = [
    [0, '0.00'],
    [7, '7.00'],
    [999, '999.00'],
    [1000, '1,000.00'],
    [12345, '12,345.00'],
    // The point of the whole function: two-digit grouping above the last three.
    [123456, '1,23,456.00'],
    [1234567, '12,34,567.00'],
    [12345678, '1,23,45,678.00'],
    [123456789, '12,34,56,789.00'],
    ['2688.5', '2,688.50'],
    [-1500, '-1,500.00'],
    ['-123456.789', '-1,23,456.79'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(formatIndianNumber(input), expected);
    });
  }

  it('honours a decimal count of zero', () => {
    assert.equal(formatIndianNumber(1234567, 0), '12,34,567');
  });

  it('rounds rather than truncates', () => {
    assert.equal(formatIndianNumber('10.005'), '10.01');
  });
});

describe('formatCurrency', () => {
  it('defaults to Rs. because Helvetica has no rupee glyph', () => {
    assert.equal(formatCurrency(1234.5), 'Rs. 1,234.50');
  });

  it('uses ₹ when the caller has an embedded Unicode font', () => {
    assert.equal(formatCurrency(1234.5, '₹'), '₹ 1,234.50');
  });

  it('omits the symbol entirely when asked', () => {
    assert.equal(formatCurrency(1234.5, ''), '1,234.50');
  });
});

describe('formatQuantity', () => {
  it('drops the decimal part on whole quantities', () => {
    assert.equal(formatQuantity(10), '10');
    assert.equal(formatQuantity(new Prisma.Decimal('10.000')), '10');
  });

  it('keeps a real fraction', () => {
    assert.equal(formatQuantity('3.5'), '3.5');
  });

  it('trims trailing zeros off a fraction', () => {
    assert.equal(formatQuantity('2.250'), '2.25');
  });
});

describe('formatDate', () => {
  it('is dd/mm/yyyy', () => {
    assert.equal(formatDate(new Date(2026, 3, 9)), '09/04/2026');
  });
});

describe('formatPercent', () => {
  it('drops .00 on a whole rate', () => {
    assert.equal(formatPercent(6), '6%');
    assert.equal(formatPercent('12.00'), '12%');
  });

  it('keeps a fractional rate', () => {
    assert.equal(formatPercent('2.5'), '2.5%');
  });
});

describe('fixed-width helpers', () => {
  it('truncates with an ellipsis', () => {
    assert.equal(truncate('A4 Copier Paper 75gsm', 10), 'A4 Copier…');
  });

  it('leaves short text alone', () => {
    assert.equal(truncate('A4', 10), 'A4');
  });

  it('pads to exactly the width', () => {
    assert.equal(padRight('A4', 5), 'A4   ');
    assert.equal(padLeft('A4', 5), '   A4');
    assert.equal(padRight('A4 Copier Paper', 5).length, 5);
  });

  it('centres', () => {
    assert.equal(centre('ABC', 9), '   ABC');
  });

  it('puts the value hard against the right edge', () => {
    const line = labelValue('TOTAL', '2,688.00', 32);
    assert.equal(line.length, 32);
    assert.ok(line.startsWith('TOTAL'));
    assert.ok(line.endsWith('2,688.00'));
  });

  it('gives the value the whole line when the label cannot fit', () => {
    assert.equal(labelValue('TOTAL', '12,34,567.00', 12), '12,34,567.00');
  });

  it('draws a rule', () => {
    assert.equal(divider(5), '-----');
    assert.equal(divider(3, '='), '===');
  });
});

describe('wrap', () => {
  it('breaks on word boundaries', () => {
    assert.deepEqual(wrap('A4 Copier Paper 75gsm White', 12), ['A4 Copier', 'Paper 75gsm', 'White']);
  });

  it('never exceeds the width', () => {
    for (const line of wrap('Sharma Stationery and General Store, Ludhiana', 16)) {
      assert.ok(line.length <= 16, `"${line}" is ${line.length} chars`);
    }
  });

  it('hard-breaks a word longer than the line', () => {
    assert.deepEqual(wrap('ABCDEFGHIJ', 4), ['ABCD', 'EFGH', 'IJ']);
  });

  it('returns a single blank line for empty input', () => {
    assert.deepEqual(wrap('   ', 10), ['']);
  });
});

describe('columns', () => {
  it('produces a row of exactly the requested width', () => {
    const row = columns(
      [
        { text: 'Qty x Rate', width: 20 },
        { text: 'Amount', width: 12, align: 'right' },
      ],
      32,
    );
    assert.equal(row.length, 32);
    assert.ok(row.endsWith('Amount'));
  });

  it('absorbs slack into the first column so the right edge stays flush', () => {
    const row = columns(
      [
        { text: 'x', width: 5 },
        { text: 'y', width: 5 },
      ],
      32,
    );
    assert.equal(row.length, 32);
    assert.equal(row.trimEnd(), 'x'.padEnd(27) + 'y');
  });
});
