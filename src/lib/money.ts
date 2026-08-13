import { Prisma } from '@prisma/client';

/**
 * All money and quantity arithmetic goes through Prisma.Decimal (decimal.js).
 *
 * Never use JS numbers for money: 0.1 + 0.2 !== 0.3, and on an invoice that
 * shows up as a one-paisa mismatch between the line total and the sum of lines,
 * which an accountant will find and you will spend an afternoon explaining.
 */
export type Money = Prisma.Decimal;

/**
 * What a service will accept for a money or quantity field.
 *
 * The Zod schemas normalise everything to strings at the HTTP boundary (so no
 * float ever round-trips through JSON), but a service called directly — from a
 * test, a script, or another service — should be able to pass a plain number.
 * Both end up in `D()` and become a Decimal either way.
 */
export type Numeric = number | string;

export const D = (value: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(value);

export const ZERO = (): Prisma.Decimal => new Prisma.Decimal(0);

/// Rupees and paise. Every stored money value is rounded to this.
export const round2 = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/// Quantities — a ream can be half, a sheet cannot, but the column is 3dp.
export const round3 = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  D(value).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

/// Rates and conversion factors need more precision than money.
export const round4 = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  D(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

/**
 * GST invoice totals are rounded to the nearest rupee, and the difference is
 * disclosed as a "Round Off" line. This is the rounding that produces it.
 */
export const roundToRupee = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  D(value).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

export const sum = (values: Prisma.Decimal.Value[]): Prisma.Decimal =>
  values.reduce<Prisma.Decimal>((acc, v) => acc.plus(D(v)), ZERO());

export const isZero = (value: Prisma.Decimal.Value): boolean => D(value).isZero();
export const isNegative = (value: Prisma.Decimal.Value): boolean => D(value).isNegative();
