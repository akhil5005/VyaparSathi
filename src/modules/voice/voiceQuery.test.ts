/**
 * The guard between the model and the database.
 *
 * `validateIntent` is four lines of filtering and it is the entire reason the
 * voice path can be trusted: the model is handed a shortlist and may pick from
 * it, and anything else it says gets dropped on the floor. Everything else in
 * the feature assumes this holds, so it is tested on its own, with no network
 * and no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent, type Shortlist } from './voiceQuery.service.js';

const list: Shortlist = {
  parties: [
    { id: 'party_sharma', displayName: 'Sharma Stationery', score: 0.9 },
    { id: 'party_verma', displayName: 'Verma Traders', score: 0.5 },
  ],
  products: [{ id: 'prod_a4', name: 'JK Copier A4 75gsm', score: 0.8 }],
};

describe('what the model is allowed to have decided', () => {
  it('accepts a clean answer that picks from the lists', () => {
    const intent = validateIntent(
      {
        intent: 'PARTY_BALANCE',
        partyId: 'party_sharma',
        confidence: 0.94,
        reasoning: 'Asked what Sharma owes.',
      },
      list,
    );

    assert.equal(intent.intent, 'PARTY_BALANCE');
    assert.equal(intent.partyId, 'party_sharma');
    assert.equal(intent.confidence, 0.94);
  });

  it('throws away an id that was never offered', () => {
    // The whole point. A hallucinated cuid is well-formed and looks real, and
    // without this it would go straight into a where clause.
    const intent = validateIntent(
      { intent: 'PARTY_BALANCE', partyId: 'clx9invented00000000', confidence: 0.99, reasoning: '' },
      list,
    );

    assert.equal(intent.partyId, null);
  });

  it('throws away a product id that belongs to the party list', () => {
    // Mixing the two lists up is a plausible model slip, and it would resolve
    // to a real row — just the wrong kind of one.
    const intent = validateIntent(
      { intent: 'PRODUCT_STOCK', productId: 'party_sharma', confidence: 0.9, reasoning: '' },
      list,
    );

    assert.equal(intent.productId, null);
  });

  it('falls back to UNKNOWN for an intent that does not exist', () => {
    const intent = validateIntent(
      { intent: 'DELETE_EVERYTHING', confidence: 1, reasoning: 'nope' },
      list,
    );

    assert.equal(intent.intent, 'UNKNOWN');
  });

  it('ignores a period it made up', () => {
    const intent = validateIntent(
      { intent: 'SALES_TOTAL', period: 'LAST_DIWALI', confidence: 0.8, reasoning: '' },
      list,
    );

    assert.equal(intent.period, null);
  });

  it('treats a missing or impossible confidence as no confidence at all', () => {
    // Defaulting the other way would let a malformed reply skip the "which one
    // did you mean?" branch, which is exactly when it should not be skipped.
    assert.equal(validateIntent({ intent: 'PARTY_BALANCE' }, list).confidence, 0);
    assert.equal(
      validateIntent({ intent: 'PARTY_BALANCE', confidence: 7 }, list).confidence,
      0,
    );
    assert.equal(
      validateIntent({ intent: 'PARTY_BALANCE', confidence: '0.9' }, list).confidence,
      0,
    );
  });

  it('survives a reply that is not an object at all', () => {
    const intent = validateIntent(null, list);
    assert.equal(intent.intent, 'UNKNOWN');
    assert.equal(intent.partyId, null);
    assert.equal(intent.confidence, 0);
  });
});
