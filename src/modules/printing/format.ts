import { Prisma } from '@prisma/client';
import { D, round2 } from '../../lib/money.js';

/**
 * Number and text formatting for printed documents. Pure, so it can be tested
 * without a printer or a PDF.
 */

/**
 * Indian digit grouping: 12,34,567.89 — not 1,234,567.89.
 *
 * The last three digits group normally, everything above them groups in twos.
 * An invoice printed with Western grouping looks wrong to every customer who
 * reads it, and on a cheque-writing trade that matters.
 */
export function formatIndianNumber(value: Prisma.Decimal.Value, decimals = 2): string {
  const amount = D(value);
  const negative = amount.isNegative();
  const fixed = amount.abs().toFixed(decimals);

  const [wholePart = '0', fractionPart] = fixed.split('.');

  let grouped: string;
  if (wholePart.length <= 3) {
    grouped = wholePart;
  } else {
    const lastThree = wholePart.slice(-3);
    const rest = wholePart.slice(0, -3);
    // Insert a comma every two digits, right to left.
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
  }

  const body = fractionPart ? `${grouped}.${fractionPart}` : grouped;
  return negative ? `-${body}` : body;
}

/**
 * Currency prefix.
 *
 * The ₹ sign (U+20B9) is absent from WinAnsi, which is what PDF's built-in
 * Helvetica uses — printing it there yields a wrong glyph. "Rs." is safe
 * everywhere, and callers that have embedded a Unicode TTF can ask for ₹.
 */
export const formatCurrency = (
  value: Prisma.Decimal.Value,
  symbol: 'Rs.' | '₹' | '' = 'Rs.',
): string => (symbol ? `${symbol} ${formatIndianNumber(value)}` : formatIndianNumber(value));

/** Quantities print without trailing zeros: 3.5 not 3.500, 10 not 10.000. */
export function formatQuantity(value: Prisma.Decimal.Value): string {
  const quantity = D(value);
  return quantity.equals(quantity.trunc())
    ? quantity.trunc().toString()
    : quantity.toDecimalPlaces(3).toString().replace(/0+$/, '').replace(/\.$/, '');
}

/** dd/mm/yyyy — how a date is read on an Indian invoice. */
export function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

export function formatPercent(value: Prisma.Decimal.Value): string {
  const percent = round2(D(value));
  return percent.equals(percent.trunc())
    ? `${percent.trunc().toString()}%`
    : `${percent.toString()}%`;
}

// ---------------------------------------------------------------------------
// Fixed-width text layout, for thermal receipts
// ---------------------------------------------------------------------------

/** Truncates with an ellipsis so a long product name can't break the columns. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

export function padRight(text: string, width: number): string {
  return truncate(text, width).padEnd(width, ' ');
}

export function padLeft(text: string, width: number): string {
  return truncate(text, width).padStart(width, ' ');
}

export function centre(text: string, width: number): string {
  const trimmed = truncate(text, width);
  const left = Math.floor((width - trimmed.length) / 2);
  return ' '.repeat(Math.max(0, left)) + trimmed;
}

/**
 * A label on the left, a value hard against the right edge — the shape every
 * total line on a receipt takes.
 */
export function labelValue(label: string, value: string, width: number): string {
  const space = width - value.length;
  if (space <= 0) return truncate(value, width);
  return `${padRight(label, space)}${value}`;
}

/** Wraps on word boundaries, breaking a word only when it exceeds the width. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += width) {
        const chunk = word.slice(i, i + width);
        if (chunk.length === width) lines.push(chunk);
        else current = chunk;
      }
      continue;
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/** A full-width rule, e.g. `divider(32)` or `divider(32, '=')`. */
export const divider = (width: number, char = '-'): string => char.repeat(Math.max(0, width));

export interface Column {
  text: string;
  width: number;
  align?: 'left' | 'right';
}

/**
 * Lays out one row of columns. The first column absorbs any rounding slack, so
 * the row is always exactly `width` characters and the right edge stays flush.
 */
export function columns(cols: Column[], width: number): string {
  const total = cols.reduce((sum, c) => sum + c.width, 0);
  const adjusted = cols.map((c, i) =>
    i === 0 ? { ...c, width: c.width + (width - total) } : c,
  );
  return adjusted
    .map((c) => (c.align === 'right' ? padLeft(c.text, c.width) : padRight(c.text, c.width)))
    .join('')
    .slice(0, width);
}
