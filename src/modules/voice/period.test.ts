/**
 * The spoken date ranges.
 *
 * Small enough to look obvious and worth testing anyway: an off-by-one at a
 * month boundary means "is mahine di sale" quietly leaves out the first day,
 * and nobody notices until the figures are compared against the ledger.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from './period.js';

/// A Wednesday, mid-month, mid-financial-year.
const WEDNESDAY = new Date('2026-08-12T09:30:00Z');

const iso = (date: Date) => date.toISOString();

describe('spoken date ranges', () => {
  it('covers the whole of today, not the moment it was asked', () => {
    const period = resolvePeriod('TODAY', WEDNESDAY);
    assert.equal(iso(period.fromDate), '2026-08-12T00:00:00.000Z');
    // A bill entered at 5pm must be inside "today" even though the question
    // was asked at half past nine in the morning.
    assert.equal(iso(period.toDate), '2026-08-12T23:59:59.999Z');
  });

  it('gives yesterday as a whole day of its own', () => {
    const period = resolvePeriod('YESTERDAY', WEDNESDAY);
    assert.equal(iso(period.fromDate), '2026-08-11T00:00:00.000Z');
    assert.equal(iso(period.toDate), '2026-08-11T23:59:59.999Z');
  });

  it('starts the week on Monday', () => {
    const period = resolvePeriod('THIS_WEEK', WEDNESDAY);
    assert.equal(iso(period.fromDate), '2026-08-10T00:00:00.000Z');
    assert.equal(iso(period.toDate), '2026-08-12T23:59:59.999Z');
  });

  it('treats Sunday as the end of its week, not the start of the next one', () => {
    // The trap in every weekday calculation: getUTCDay() is 0 on Sunday, so the
    // naive version resets the week a day early and loses six days of sales.
    const sunday = new Date('2026-08-16T12:00:00Z');
    const period = resolvePeriod('THIS_WEEK', sunday);
    assert.equal(iso(period.fromDate), '2026-08-10T00:00:00.000Z');
  });

  it('runs this month from the first to today', () => {
    const period = resolvePeriod('THIS_MONTH', WEDNESDAY);
    assert.equal(iso(period.fromDate), '2026-08-01T00:00:00.000Z');
    assert.equal(iso(period.toDate), '2026-08-12T23:59:59.999Z');
  });

  it('ends last month on its own last day, whatever length it was', () => {
    assert.equal(iso(resolvePeriod('LAST_MONTH', WEDNESDAY).toDate), '2026-07-31T23:59:59.999Z');

    // February in a non-leap year is the case a hardcoded 30 would get wrong.
    const march = new Date('2026-03-09T00:00:00Z');
    const period = resolvePeriod('LAST_MONTH', march);
    assert.equal(iso(period.fromDate), '2026-02-01T00:00:00.000Z');
    assert.equal(iso(period.toDate), '2026-02-28T23:59:59.999Z');
  });

  it('rolls last month back across the new year', () => {
    const january = new Date('2026-01-15T00:00:00Z');
    const period = resolvePeriod('LAST_MONTH', january);
    assert.equal(iso(period.fromDate), '2025-12-01T00:00:00.000Z');
    assert.equal(iso(period.toDate), '2025-12-31T23:59:59.999Z');
  });

  it('means the financial year, not the calendar year', () => {
    // August 2026 sits in FY 2026-27, which began in April 2026.
    assert.equal(iso(resolvePeriod('THIS_YEAR', WEDNESDAY).fromDate), '2026-04-01T00:00:00.000Z');

    // February 2026 sits in FY 2025-26, which began in April 2025 — the case a
    // calendar year gets wrong for a quarter of the year.
    const february = new Date('2026-02-20T00:00:00Z');
    assert.equal(iso(resolvePeriod('THIS_YEAR', february).fromDate), '2025-04-01T00:00:00.000Z');
  });

  it('says out loud which days it counted', () => {
    // The answer repeats this, so a wrong assumption is visible rather than
    // silently baked into a number somebody then quotes.
    assert.equal(resolvePeriod('THIS_MONTH', WEDNESDAY).label, 'this month so far');
    assert.match(resolvePeriod('THIS_YEAR', WEDNESDAY).label, /April 2026/);
  });
});
