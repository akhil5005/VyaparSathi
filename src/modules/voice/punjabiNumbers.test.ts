/**
 * Run with: npm test
 *
 * These cases are the actual failure modes. Whisper will hand you "sarhe teen"
 * and an LLM will happily call it 3 — this suite is the thing standing between
 * that and a wrong invoice, so add a case here every time the shop says
 * something new.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { digitizeNumbers, extractNumbers, parsePunjabiNumber } from './punjabiNumbers.js';

describe('parsePunjabiNumber', () => {
  const cases: [string, number][] = [
    // plain units
    ['ik', 1],
    ['das', 10],
    ['bees', 20],
    ['pachchi', 25],
    ['nabbe', 90],

    // hundreds
    ['sau', 100],
    ['do sau', 200],
    ['do sau chali', 240],
    ['panj sau', 500],

    // the fractional multipliers — the whole reason this file exists
    ['sava sau', 125],
    ['sava do sau', 225],
    ['sava do', 2.25],
    ['sarhe teen', 3.5],
    ['sarhe teen sau', 350],
    ['paune char', 3.75],
    ['paune char sau', 375],
    ['dedh', 1.5],
    ['dedh sau', 150],
    ['dhai', 2.5],
    ['dhai sau', 250],
    ['adha', 0.5],
    ['paun', 0.75],

    // thousands and above
    ['hazaar', 1000],
    ['panj hazaar', 5000],
    ['do hazaar panj sau', 2500],
    ['ik lakh', 100_000],

    // filler words between numerals
    ['do sau te chali', 240],

    // digits straight from the transcriber
    ['240', 240],
    ['10', 10],

    // Gurmukhi script
    ['ਦੋ ਸੌ', 200],
    ['ਸਾਢੇ ਤਿੰਨ', 3.5],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      assert.equal(parsePunjabiNumber(input), expected);
    });
  }

  it('returns null for a non-number', () => {
    assert.equal(parsePunjabiNumber('Sharma Stationery'), null);
  });
});

describe('digitizeNumbers', () => {
  it('rewrites a full billing utterance', () => {
    assert.equal(
      digitizeNumbers('Sharma Stationery de bill vich das ream A4 paper do sau chali rate te add karo'),
      'Sharma Stationery de bill vich 10 ream A4 paper 240 rate te add karo',
    );
  });

  it('handles two fractional numbers in one sentence', () => {
    assert.equal(
      digitizeNumbers('sarhe teen ream sava do sau rate te'),
      '3.5 ream 225 rate te',
    );
  });

  it('leaves text with no numbers untouched', () => {
    assert.equal(digitizeNumbers('Sharma nu kinna paisa dena hai'), 'Sharma nu kinna paisa dena hai');
  });
});

describe('extractNumbers', () => {
  it('finds every number with its token span', () => {
    const found = extractNumbers('das ream A4 paper do sau chali rate');
    assert.equal(found.length, 2);
    assert.equal(found[0]!.value, 10);
    assert.equal(found[1]!.value, 240);
    assert.deepEqual(found[1]!.matchedTokens, ['do', 'sau', 'chali']);
  });
});
