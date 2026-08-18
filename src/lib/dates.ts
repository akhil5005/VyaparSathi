import { z } from 'zod';

/**
 * A date a shop's books could plausibly carry.
 *
 * `z.coerce.date()` alone is not enough. It rejects unparseable text, but it
 * happily accepts anything JavaScript can turn into a `Date` — and JavaScript
 * accepts years far outside what Postgres will store or what any accounting
 * period could mean. A browser's native date input makes this trivially
 * reachable: the year is a free-typed segment, so a mistyped keystroke turns
 * `2026` into `82026` without a word of complaint, and the request that
 * follows fails somewhere deep in the driver as a 500 rather than as the
 * validation error it plainly is.
 *
 * That was found on the ledger screen, where a fat-fingered "From" date
 * returned "Something went wrong on our side" — which is both wrong and
 * unhelpful, since the only thing wrong was on the user's side and a sentence
 * would have fixed it.
 *
 * The bounds are deliberately loose. Nothing in this trade predates 1900 or
 * reaches 2100; a date outside them is a typo, never a transaction.
 */
export const MIN_BUSINESS_YEAR = 1900;
export const MAX_BUSINESS_YEAR = 2100;

const MIN = new Date(Date.UTC(MIN_BUSINESS_YEAR, 0, 1));
const MAX = new Date(Date.UTC(MAX_BUSINESS_YEAR, 11, 31, 23, 59, 59, 999));

/**
 * Drop-in replacement for `z.coerce.date()` on anything a client can send.
 *
 * Use it for every date that crosses the HTTP boundary — query strings and
 * request bodies alike. Dates computed server-side do not need it.
 */
export const businessDate = (label = 'Date') =>
  z.coerce
    .date({ invalid_type_error: `${label} is not a valid date` })
    .min(MIN, { message: `${label} is before ${MIN_BUSINESS_YEAR} — check the year` })
    .max(MAX, { message: `${label} is after ${MAX_BUSINESS_YEAR} — check the year` });
