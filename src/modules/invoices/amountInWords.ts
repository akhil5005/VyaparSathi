import { Prisma } from '@prisma/client';
import { D, round2 } from '../../lib/money.js';

/**
 * Amount in words, Indian numbering system (crore / lakh / thousand).
 *
 * Printing this on the invoice is conventional and, for cheque-heavy trades,
 * genuinely useful — it is what a customer reads back when writing the cheque.
 * Western grouping ("two million") would be wrong here.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

/** 0–99. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n]!;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? TENS[tens]! : `${TENS[tens]} ${ONES[ones]}`;
}

/** 0–999. */
function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Converts a whole number to words using Indian grouping:
 * crore (10^7), lakh (10^5), thousand (10^3), hundred.
 */
export function integerToWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('integerToWords expects a non-negative finite number');
  if (value === 0) return 'Zero';

  let n = Math.floor(value);
  const parts: string[] = [];

  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1_000);
  n %= 1_000;

  // A crore count above 99 keeps grouping in crores ("One Thousand Crore"),
  // which is how Indian English actually reads it.
  if (crore > 0) parts.push(`${crore > 999 ? integerToWords(crore) : threeDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${threeDigits(thousand)} Thousand`);
  if (n > 0) parts.push(threeDigits(n));

  return parts.join(' ');
}

/**
 * Full invoice line: "Rupees Two Thousand Four Hundred Only" or, when there are
 * paise, "... and Fifty Paise Only".
 */
export function amountInWords(amount: Prisma.Decimal.Value, currency = 'Rupees'): string {
  const value = round2(D(amount));
  const negative = value.isNegative();
  const absolute = value.abs();

  const rupees = absolute.floor().toNumber();
  const paise = absolute.minus(absolute.floor()).times(100).round().toNumber();

  const segments: string[] = [];
  segments.push(`${currency} ${integerToWords(rupees)}`);
  if (paise > 0) segments.push(`and ${twoDigits(paise)} Paise`);
  segments.push('Only');

  const words = segments.join(' ');
  return negative ? `Minus ${words}` : words;
}
