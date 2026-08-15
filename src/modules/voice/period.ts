/**
 * The handful of date ranges a shopkeeper actually asks for out loud.
 *
 * "Aj di sale kinni hoi?" — today. "Is mahine?" — this month. Nobody says
 * "between the fourteenth of June and the third of August" at a counter, so
 * this is a closed list rather than a date parser, and the model's only job is
 * to pick one of these names. Anything it cannot place comes back null and the
 * caller falls back to a sensible default it can state out loud.
 *
 * Boundaries are UTC, matching `periodRange` in gstSetOff.ts — the whole app
 * stores and compares invoice dates that way, and a range that disagreed with
 * the rest of it would quietly drop the first or last day of a month.
 */

export const PERIOD_NAMES = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_YEAR',
] as const;

export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface Period {
  fromDate: Date;
  toDate: Date;
  /// How the answer refers to it, so the spoken reply says which days it counted.
  label: string;
}

const startOfDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 0, 0, 0, 0));

/// The last instant of the day, so `lte` includes everything dated that day.
const endOfDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

export function resolvePeriod(name: PeriodName, today = new Date()): Period {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();

  switch (name) {
    case 'TODAY':
      return { fromDate: startOfDay(year, month, day), toDate: endOfDay(year, month, day), label: 'today' };

    case 'YESTERDAY':
      return {
        fromDate: startOfDay(year, month, day - 1),
        toDate: endOfDay(year, month, day - 1),
        label: 'yesterday',
      };

    /**
     * Monday to today, not a rolling seven days.
     *
     * "Is hafte" means the week you are standing in. A rolling window would
     * give a different answer to the same question asked twice in a day, which
     * is exactly the kind of thing that makes someone stop trusting the app.
     */
    case 'THIS_WEEK': {
      const weekday = today.getUTCDay();
      const sinceMonday = weekday === 0 ? 6 : weekday - 1;
      return {
        fromDate: startOfDay(year, month, day - sinceMonday),
        toDate: endOfDay(year, month, day),
        label: 'this week so far',
      };
    }

    case 'THIS_MONTH':
      return {
        fromDate: startOfDay(year, month, 1),
        toDate: endOfDay(year, month, day),
        label: 'this month so far',
      };

    // Day 0 of a month is the last day of the one before it, which saves
    // knowing whether February had 28 days this year.
    case 'LAST_MONTH':
      return {
        fromDate: startOfDay(year, month - 1, 1),
        toDate: endOfDay(year, month, 0),
        label: 'last month',
      };

    /**
     * The financial year, not the calendar year — April to March.
     *
     * Every figure in this trade is quoted against the FY: the returns, the
     * accountant's questions, the comparison with last year. A January-based
     * "this year" would be an answer to a question nobody asked.
     */
    case 'THIS_YEAR': {
      const fyStartYear = month >= 3 ? year : year - 1;
      return {
        fromDate: startOfDay(fyStartYear, 3, 1),
        toDate: endOfDay(year, month, day),
        label: `this financial year (since April ${fyStartYear})`,
      };
    }
  }
}
