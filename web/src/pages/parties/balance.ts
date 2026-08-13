import { formatMoney } from '../../lib/money';

/**
 * Turning a signed balance into something a shopkeeper can read.
 *
 * The server signs balances from the shop's point of view: **positive means
 * they owe us**, negative means we owe them. Rendering that raw puts "−₹11,710"
 * on the screen, which reads as an error rather than as money payable to a
 * supplier — and the one thing this figure must never be is ambiguous about
 * which way the debt runs.
 *
 * So the sign becomes words, and the number is always shown unsigned.
 */
export type BalanceDirection = 'owed-to-us' | 'owed-by-us' | 'settled';

export interface ReadableBalance {
  direction: BalanceDirection;
  /// Always positive, formatted with the rupee sign.
  amount: string;
  /// "owes you" / "you owe" / "settled up"
  phrase: string;
  /// Tailwind text colour. Money owed *to* us is the one worth chasing.
  tone: string;
}

export function readBalance(value: string | null | undefined): ReadableBalance {
  const amount = Number(value ?? 0);

  // Guard against a stray floating-point crumb showing as a live balance.
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) {
    return {
      direction: 'settled',
      amount: formatMoney('0'),
      phrase: 'settled up',
      tone: 'text-slate-500',
    };
  }

  if (amount > 0) {
    return {
      direction: 'owed-to-us',
      amount: formatMoney(String(amount)),
      phrase: 'owes you',
      tone: 'text-amber-600 dark:text-amber-400',
    };
  }

  return {
    direction: 'owed-by-us',
    amount: formatMoney(String(Math.abs(amount))),
    phrase: 'you owe',
    tone: 'text-sky-600 dark:text-sky-400',
  };
}
