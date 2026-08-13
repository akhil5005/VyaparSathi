/**
 * Indian financial year runs 1 April – 31 March and is written "2026-27".
 *
 * This matters beyond cosmetics: invoice numbering restarts each financial year
 * and must be gap-free *within* the year, so getting the boundary wrong on
 * 31 March / 1 April corrupts the sequence.
 */
export function financialYearOf(date: Date, fyStartMonth = 4): string {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= fyStartMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export const currentFinancialYear = (fyStartMonth = 4): string =>
  financialYearOf(new Date(), fyStartMonth);

/** First instant of the financial year, for period reports. */
export function financialYearStart(fy: string, fyStartMonth = 4): Date {
  const startYear = Number(fy.slice(0, 4));
  return new Date(Date.UTC(startYear, fyStartMonth - 1, 1, 0, 0, 0, 0));
}

/** Last instant of the financial year. */
export function financialYearEnd(fy: string, fyStartMonth = 4): Date {
  const startYear = Number(fy.slice(0, 4));
  return new Date(Date.UTC(startYear + 1, fyStartMonth - 1, 1, 0, 0, 0, -1));
}
