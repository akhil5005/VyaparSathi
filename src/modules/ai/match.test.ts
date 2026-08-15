/**
 * Name matching, against the strings a real supplier bill actually carries.
 *
 * This layer decides which account a scanned bill lands on. A wrong confident
 * match is far worse than no match: it puts a purchase against the wrong
 * supplier, moves the wrong party balance, and nobody notices until a
 * reconciliation months later. So the cases below are mostly about *refusing*
 * to be confident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, normalize, rank, similarity } from './match.js';

const PARTIES = [
  { id: 'p1', name: 'JK Paper Mills' },
  { id: 'p2', name: 'Sharma Stationery' },
  { id: 'p3', name: 'Sharma Stationers' },
  { id: 'p4', name: 'Century Pulp and Paper' },
];
const names = (p: { name: string }) => [p.name];

describe('normalize', () => {
  it('strips punctuation so J.K. and JK are one token', () => {
    assert.equal(normalize('M/S J.K. PAPER MILLS LTD.'), 'jk paper mills');
  });

  it('drops company noise words that carry no identity', () => {
    assert.equal(normalize('The Century Pulp & Paper Co. Pvt Ltd'), 'century pulp paper');
  });

  it('keeps digits glued to letters, so A-4 and A4 agree', () => {
    assert.equal(normalize('A-4 Copier'), 'a4 copier');
    assert.equal(normalize('A4 Copier'), 'a4 copier');
  });
});

describe('similarity', () => {
  it('is 1 for names that differ only in decoration', () => {
    assert.equal(similarity('M/S J.K. PAPER MILLS LTD.', 'JK Paper Mills'), 1);
  });

  it('stays high when the invoice line carries extra words', () => {
    // The supplier prints a description; the catalogue holds a name.
    const score = similarity('A4 COPIER 75 GSM 500 SHEETS REAM', 'JK Copier A4 75gsm');
    assert.ok(score >= 0.6, `expected a strong match, got ${score}`);
  });

  it('survives a spelling slip', () => {
    assert.ok(similarity('Sharma Stationary', 'Sharma Stationery') >= 0.8);
  });

  it('is near zero for unrelated names', () => {
    assert.ok(similarity('JK Paper Mills', 'Bharat Electricals') < 0.3);
  });

  it('is zero rather than NaN for empty input', () => {
    assert.equal(similarity('', 'JK Paper Mills'), 0);
    assert.equal(similarity('   ', ''), 0);
  });
});

describe('rank', () => {
  it('puts the real supplier first', () => {
    const [top] = rank('M/S J.K. PAPER MILLS LTD.', PARTIES, names);
    assert.equal(top!.item.id, 'p1');
  });

  it('offers nothing at all when nothing is close', () => {
    assert.deepEqual(rank('Bharat Electricals', PARTIES, names), []);
  });

  it('returns both near-identical names rather than choosing', () => {
    const ranked = rank('Sharma Stationery', PARTIES, names);
    const ids = ranked.map((c) => c.item.id);
    assert.ok(ids.includes('p2') && ids.includes('p3'), `got ${ids}`);
  });
});

describe('bestMatch', () => {
  it('is confident about an unambiguous supplier', () => {
    const match = bestMatch('M/S J.K. PAPER MILLS LTD.', PARTIES, names);
    assert.equal(match!.item.id, 'p1');
    assert.equal(match!.confident, true);
  });

  it('refuses to be confident between Stationery and Stationers', () => {
    // Both score highly and are a hair apart. Picking one silently is how a
    // bill ends up on the wrong account.
    const match = bestMatch('Sharma Stationary', PARTIES, names);
    assert.ok(match, 'it should still offer a candidate');
    assert.equal(match!.confident, false, 'but must not claim confidence');
  });

  it('returns null when nothing resembles the name', () => {
    assert.equal(bestMatch('Bharat Electricals', PARTIES, names), null);
  });

  it('matches a product on an alias, not only its catalogue name', () => {
    const products = [
      { id: 'x1', name: 'JK Copier A4 75gsm', aliases: ['safed kagaz', 'A4 sada'] },
      { id: 'x2', name: 'Century Maplitho A4', aliases: [] },
    ];
    const match = bestMatch('SAFED KAGAZ', products, (p) => [p.name, ...p.aliases]);
    assert.equal(match!.item.id, 'x1');
    assert.equal(match!.confident, true);
  });
});
