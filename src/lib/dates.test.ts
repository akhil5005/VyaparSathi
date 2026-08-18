/**
 * Bounds on any date a client can send.
 *
 * The case that prompted this: a native date input's year is a free-typed
 * segment, so one stray keystroke turns 2026 into 82026. `z.coerce.date()`
 * accepted it — it is a perfectly valid JavaScript `Date` — and the ledger
 * endpoint then returned a 500 from somewhere deep in the driver. A typo in a
 * date box has to be a 400 with a sentence, not a server error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { businessDate } from './dates.js';

const parse = (value: unknown) => businessDate('From date').safeParse(value);

describe('businessDate', () => {
  it('accepts an ordinary date from a date input', () => {
    const result = parse('2026-04-01');
    assert.ok(result.success);
    assert.equal(result.data.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  it('accepts a Date object unchanged', () => {
    const when = new Date(Date.UTC(2026, 7, 14));
    const result = parse(when);
    assert.ok(result.success);
    assert.equal(result.data.getTime(), when.getTime());
  });

  it('rejects the mistyped year that returned a 500', () => {
    const result = parse('82026-04-01');
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0]!.message, /after 2100 — check the year/);
  });

  it('names the field, so the message points at the box to fix', () => {
    const result = parse('1799-12-31');
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0]!.message, /^From date is before 1900/);
  });

  it('rejects text that is not a date at all', () => {
    assert.equal(parse('not a date').success, false);
  });

  // The bounds are inclusive: a shop opening its books on 1 January 1900 is
  // absurd but not something to refuse on the boundary itself.
  it('allows the boundaries themselves', () => {
    assert.ok(parse('1900-01-01').success);
    assert.ok(parse('2100-12-31').success);
  });

  it('rejects one day past the far boundary', () => {
    assert.equal(parse('2101-01-01').success, false);
  });
});
