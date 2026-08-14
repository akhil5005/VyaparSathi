import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import type { GstSummaryResponse, TaxHeads } from '../../lib/types';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { recentPeriods } from './periods';

/**
 * What the month actually costs: GST collected, less GST already paid.
 *
 * The set-off is the part nobody can do in their head. Credit does not simply
 * pool — IGST credit is spent first and can go against any head, but **CGST
 * credit can never pay an SGST liability or the reverse**. So a shop can be
 * sitting on plenty of unused credit and still owe cash, which looks like an
 * error until the two walls are drawn on screen.
 *
 * Everything here is computed server-side and arrives as strings. The browser
 * adds nothing up.
 */
export function TaxSummaryTab() {
  const periods = recentPeriods();
  const [period, setPeriod] = useState(periods[0]!.value);

  const summary = useQuery({
    queryKey: ['gst-summary', period],
    queryFn: () =>
      api.get<GstSummaryResponse>('/api/purchases/gst-summary', { query: { period } }),
  });

  const data = summary.data;

  return (
    <div className="space-y-5">
      <label className="block max-w-xs">
        <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Period
        </span>
        <select
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
        >
          {periods.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {summary.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : summary.error ? (
        <ErrorAlert error={summary.error} />
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure
              label="GST collected on sales"
              value={formatMoney(data.sales.totalTax)}
              caption={`${data.sales.invoiceCount} invoice${data.sales.invoiceCount === 1 ? '' : 's'}`}
            />
            <Figure
              label="GST paid on purchases"
              value={formatMoney(data.purchases.totalTax)}
              caption={`${data.purchases.invoiceCount} bill${data.purchases.invoiceCount === 1 ? '' : 's'}`}
              tone="good"
            />
            <Figure
              label="To pay in cash"
              value={formatMoney(data.setOff.totalCashPayable)}
              caption={
                Number(data.setOff.totalCarriedForward) > 0
                  ? `${formatMoney(data.setOff.totalCarriedForward)} credit carried forward`
                  : 'After using available credit'
              }
              tone={Number(data.setOff.totalCashPayable) > 0 ? 'owed' : 'good'}
              strong
            />
          </div>

          {Number(data.priorPeriodUnclaimed.total) > 0 ? (
            <Alert tone="warning" title="Credit from earlier months is still unclaimed">
              {formatMoney(data.priorPeriodUnclaimed.total)} across{' '}
              {data.priorPeriodUnclaimed.invoiceCount} bill
              {data.priorPeriodUnclaimed.invoiceCount === 1 ? '' : 's'} dated before this period has
              never been claimed. That is money back that has not been asked for —{' '}
              <Link to="/purchases" className="font-medium underline underline-offset-2">
                see which bills
              </Link>
              .
            </Alert>
          ) : null}

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
              How the credit was used
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                    <th className="px-4 py-2.5 font-medium">Head</th>
                    <th className="px-3 py-2.5 text-right font-medium">Collected</th>
                    <th className="px-3 py-2.5 text-right font-medium">Credit used</th>
                    <th className="px-3 py-2.5 text-right font-medium">Pay in cash</th>
                    <th className="px-4 py-2.5 text-right font-medium">Carried forward</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {HEADS.map(({ key, label }) => (
                    <tr key={key}>
                      <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-slate-100">
                        {label}
                      </td>
                      <Amount value={data.setOff.outputTax[key]} />
                      <Amount value={data.setOff.creditUtilised[key]} tone="good" />
                      <Amount value={data.setOff.cashPayable[key]} tone="owed" />
                      <Amount value={data.setOff.creditCarriedForward[key]} className="px-4" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <Alert tone="info">
            {/* Drawn out because an unused-credit-but-still-owing month reads as
                a bug otherwise, and it is the single most common confusion. */}
            CGST credit can only pay CGST, and SGST credit only SGST — they can never cover each
            other. IGST credit is used first and can go against any head. So it is entirely normal
            to be carrying credit forward and still owe cash in the same month.
          </Alert>

          <p className="text-xs text-slate-500">{data.disclaimer}</p>
        </>
      ) : null}
    </div>
  );
}

const HEADS: { key: keyof TaxHeads; label: string }[] = [
  { key: 'igst', label: 'IGST' },
  { key: 'cgst', label: 'CGST' },
  { key: 'sgst', label: 'SGST' },
  { key: 'cess', label: 'Cess' },
];

function Amount({
  value,
  tone = 'plain',
  className = 'px-3',
}: {
  value: string;
  tone?: 'plain' | 'good' | 'owed';
  className?: string;
}) {
  const zero = Number(value) === 0;
  const toneClass = zero
    ? 'text-slate-400'
    : {
        plain: 'text-slate-700 dark:text-slate-300',
        good: 'text-emerald-700 dark:text-emerald-400',
        owed: 'text-amber-700 dark:text-amber-400',
      }[tone];

  return <td className={`tabular py-2.5 text-right ${className} ${toneClass}`}>{formatMoney(value)}</td>;
}

function Figure({
  label,
  value,
  caption,
  tone = 'plain',
  strong = false,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: 'plain' | 'good' | 'owed';
  strong?: boolean;
}) {
  const toneClass = {
    plain: 'text-slate-900 dark:text-slate-100',
    good: 'text-emerald-700 dark:text-emerald-400',
    owed: 'text-amber-700 dark:text-amber-400',
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`tabular mt-1 ${strong ? 'text-2xl' : 'text-xl'} font-semibold ${toneClass}`}>
        {value}
      </p>
      {caption ? <p className="mt-0.5 text-xs text-slate-500">{caption}</p> : null}
    </div>
  );
}
