/**
 * Display formatting for money and quantities.
 *
 * Everything here takes a **string** and returns a string. The API sends
 * NUMERIC columns as strings because they do not survive a JavaScript number,
 * and the moment one is parsed to format it, the paise are at risk. So these
 * functions do their work on the digits themselves.
 *
 * Nothing in this app performs arithmetic on money. Every total, tax split and
 * round-off is computed by the server and sent down ready to display — which is
 * also the only way the printed invoice and the screen can be guaranteed to
 * agree.
 */

/**
 * Indian digit grouping: 12,34,567.89 — not 1,234,567.89.
 *
 * The last three digits group normally, everything above them in twos. Western
 * grouping on an invoice looks wrong to every customer who reads it.
 */
export function formatIndian(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '0.00';

  const raw = String(value).trim();
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;

  const [wholeRaw = '0', fractionRaw = ''] = unsigned.split('.');

  // Round at the requested precision without going through a float, by looking
  // at the first dropped digit. Values here are at most 2 decimal places from
  // the server, so this never has to carry far.
  let whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  let fraction = fractionRaw;

  if (decimals === 0) {
    if (Number(fraction[0] ?? '0') >= 5) whole = incrementDigits(whole);
    fraction = '';
  } else if (fraction.length > decimals) {
    const keep = fraction.slice(0, decimals);
    if (Number(fraction[decimals] ?? '0') >= 5) {
      const bumped = incrementDigits(keep);
      if (bumped.length > keep.length) {
        whole = incrementDigits(whole);
        fraction = '0'.repeat(decimals);
      } else {
        fraction = bumped;
      }
    } else {
      fraction = keep;
    }
  } else {
    fraction = fraction.padEnd(decimals, '0');
  }

  const grouped =
    whole.length <= 3
      ? whole
      : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;

  const body = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return negative && !/^0(\.0*)?$/.test(`${whole}.${fraction}`) ? `-${body}` : body;
}

/// Adds one to a string of digits, carrying, without touching Number.
function incrementDigits(digits: string): string {
  const out = digits.split('');
  let i = out.length - 1;
  while (i >= 0) {
    if (out[i] === '9') {
      out[i] = '0';
      i--;
    } else {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
  }
  return `1${out.join('')}`;
}

/** With the rupee sign. The UI is a browser, so ₹ is safe here (unlike the PDF). */
export const formatMoney = (value: string | number | null | undefined): string =>
  `₹${formatIndian(value)}`;

/** Quantities drop trailing zeros: 3.5 not 3.500, 10 not 10.000. */
export function formatQuantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const raw = String(value).trim();
  if (!raw.includes('.')) return raw;
  const trimmed = raw.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/** A percentage without a pointless .00: "18%" not "18.00%". */
export function formatPercent(value: string | number | null | undefined): string {
  return `${formatQuantity(value)}%`;
}

/** dd/mm/yyyy — how a date is read on an Indian invoice. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

/// For `<input type="date">`, which insists on yyyy-mm-dd regardless of locale.
export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const todayInput = (): string => toDateInput(new Date());

/**
 * Whether a string is a usable positive amount.
 *
 * Used to enable the "Save" button, not to compute anything — parsing to a
 * float is acceptable for a yes/no check where a half-paisa cannot change the
 * answer.
 */
export const isPositiveAmount = (value: string): boolean => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
};
