import { formatDate, formatMoney } from '../../lib/money';
import type { OutstandingParty } from '../../lib/types';
import { Button } from '../../components/Button';

/**
 * The udhaar list — every customer who owes money, worst first.
 *
 * Sorted by the server on total owed rather than by name, because the question
 * being asked is "who do I chase today", not "look up a customer". The ageing
 * columns are what turn that from a guess into a decision: ₹50,000 owed for a
 * fortnight is ordinary trade credit, ₹50,000 owed for four months is a
 * problem.
 */
export function OutstandingTable({
  parties,
  asOf,
  onCollect,
}: {
  parties: OutstandingParty[];
  asOf: string | undefined;
  onCollect: (party: OutstandingParty) => void;
}) {
  if (parties.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
        Nothing outstanding. Everyone has paid.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-3 py-2.5 text-right font-medium">0–30</th>
              <th className="px-3 py-2.5 text-right font-medium">31–60</th>
              <th className="px-3 py-2.5 text-right font-medium">61–90</th>
              <th className="px-3 py-2.5 text-right font-medium">90+</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {parties.map((party) => {
              const overdue = Number(party.ageing.over90) > 0;
              return (
                <tr key={party.partyId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {party.partyName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {party.invoiceCount} bill{party.invoiceCount === 1 ? '' : 's'} · oldest{' '}
                      {formatDate(party.oldestInvoiceDate)}
                    </p>
                  </td>
                  <Cell value={party.ageing.current} />
                  <Cell value={party.ageing.days31to60} />
                  <Cell value={party.ageing.days61to90} tone="warn" />
                  <Cell value={party.ageing.over90} tone="bad" />
                  <td
                    className={[
                      'tabular px-3 py-3 text-right font-semibold',
                      overdue ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100',
                    ].join(' ')}
                  >
                    {formatMoney(party.ageing.total)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="secondary" onClick={() => onCollect(party)}>
                      Collect
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {asOf ? (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800">
          Aged as at {formatDate(asOf)}. Bills with credit terms age from their due date, the rest
          from the invoice date.
        </p>
      ) : null}
    </div>
  );
}

/// Zero prints as a muted dash — a column of ₹0.00 is noise to read past.
function Cell({ value, tone = 'plain' }: { value: string; tone?: 'plain' | 'warn' | 'bad' }) {
  const zero = Number(value) === 0;
  const toneClass = zero
    ? 'text-slate-300 dark:text-slate-700'
    : { plain: 'text-slate-700 dark:text-slate-300', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-rose-600 dark:text-rose-400' }[tone];

  return <td className={`tabular px-3 py-3 text-right ${toneClass}`}>{zero ? '—' : formatMoney(value)}</td>;
}
