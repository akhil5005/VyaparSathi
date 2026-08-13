const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface PeriodOption {
  /// "2026-07", the form the API takes.
  value: string;
  label: string;
}

/**
 * The months a return might plausibly be prepared for, newest first.
 *
 * The default is **last month**, not this one: GSTR-1 is filed by the 11th for
 * the month just gone, so on any ordinary day that is the month being worked
 * on. The current month is still offered — it is the natural way to check where
 * the month stands — but it is not what the screen opens on, because opening on
 * a half-finished month invites filing it.
 */
export function recentPeriods(today = new Date(), count = 13): PeriodOption[] {
  const options: PeriodOption[] = [];

  for (let back = 1; back <= count; back += 1) {
    options.push(option(new Date(today.getFullYear(), today.getMonth() - back, 1)));
  }

  // The current month sits at the end, below the months that can actually be
  // filed, and says so.
  const current = option(new Date(today.getFullYear(), today.getMonth(), 1));
  options.push({ ...current, label: `${current.label} (in progress)` });

  return options;
}

function option(date: Date): PeriodOption {
  const year = date.getFullYear();
  const month = date.getMonth();
  return {
    value: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: `${MONTHS[month]} ${year}`,
  };
}
