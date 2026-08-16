import { formatDate, formatMoney } from '../../lib/money';
import type { Payment, PaymentMode } from '../../lib/types';

const MODE_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CHEQUE: 'Cheque',
  BANK_TRANSFER: 'Bank',
  NEFT_RTGS: 'NEFT',
  CARD: 'Card',
  ADJUSTMENT: 'Adjustment',
};

/**
 * What has moved, both ways.
 *
 * Direction is shown as a word and a sign rather than colour alone: a receipt
 * and a supplier payment are otherwise the same row, and mistaking one for the
 * other is the kind of error that survives until somebody reconciles a bank
 * statement.
 *
 * A reversed payment stays on the list, struck through — reversing is not
 * deleting. The voucher number was issued, it may be on a receipt in someone's
 * pocket, and the audit trail has to show that it existed and what happened
 * to it.
 */
export function PaymentList({
  payments,
  totalAmount,
  totalOnAccount,
}: {
  payments: Payment[];
  totalAmount: string | undefined;
  totalOnAccount: string | undefined;
}) {
  if (payments.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
        No payments recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap gap-6 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <Summary label="Total on this page" value={totalAmount} />
        <Summary
          label="Still on account"
          value={totalOnAccount}
          hint="Recorded but not yet applied to a bill"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
              <th className="px-4 py-2.5 font-medium">Voucher</th>
              <th className="px-3 py-2.5 font-medium">Party</th>
              <th className="px-3 py-2.5 font-medium">How</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 text-right font-medium">On account</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {payments.map((payment) => {
              const reversed = Boolean(payment.reversedAt);
              const onAccount = Number(payment.unallocatedAmount) > 0;
              const out = payment.direction === 'PAYMENT';

              return (
                <tr
                  key={payment.id}
                  className={reversed ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}
                >
                  <td className="px-4 py-3">
                    <p
                      className={[
                        'font-mono text-xs',
                        reversed ? 'line-through' : '',
                        'text-slate-900 dark:text-slate-100',
                      ].join(' ')}
                    >
                      {payment.voucherNumber}
                    </p>
                    <p className="text-xs text-slate-500">{formatDate(payment.paymentDate)}</p>
                  </td>

                  <td className="px-3 py-3 text-slate-900 dark:text-slate-100">
                    <span className="mr-2 rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ring-slate-300 dark:ring-slate-700">
                      {out ? 'Paid to' : 'From'}
                    </span>
                    {payment.party?.displayName ?? '—'}
                    {reversed ? (
                      <p className="text-xs text-rose-600 dark:text-rose-400">
                        Reversed{payment.reversedReason ? ` — ${payment.reversedReason}` : ''}
                      </p>
                    ) : null}
                  </td>

                  <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
                    {MODE_LABEL[payment.mode]}
                    {payment.cheque ? (
                      <span className="ml-1 font-mono text-xs text-slate-400">
                        #{payment.cheque.chequeNumber}
                      </span>
                    ) : payment.referenceNumber ? (
                      <span className="ml-1 font-mono text-xs text-slate-400">
                        {payment.referenceNumber}
                      </span>
                    ) : null}
                  </td>

                  <td
                    className={[
                      'tabular px-3 py-3 text-right font-medium',
                      out
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-slate-900 dark:text-slate-100',
                    ].join(' ')}
                  >
                    {out ? '−' : ''}
                    {formatMoney(payment.amount)}
                  </td>

                  <td className="tabular px-4 py-3 text-right">
                    {onAccount ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {formatMoney(payment.unallocatedAmount)}
                      </span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-700">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value, hint }: { label: string; value: string | undefined; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="tabular text-lg font-semibold text-slate-900 dark:text-slate-100">
        {formatMoney(value)}
      </p>
      {hint ? <p className="text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}
