import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, requestBlob } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import type { Gstr1Summary } from '../../lib/types';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { recentPeriods } from './periods';
import { TaxSummaryTab } from './TaxSummaryTab';

type Tab = 'gstr1' | 'summary';

/**
 * The two things a shop needs at GST time.
 *
 * **GSTR-1** is the return itself. The file the portal wants is unreadable —
 * terse keys, no invoice you can recognise, amounts as bare floats — so this
 * shows the same month in words and figures first, and only then offers the
 * download.
 *
 * **Tax summary** is what it costs: GST collected against GST already paid,
 * with the set-off applied.
 *
 * Both are **working papers for the CA**. Nothing here talks to the GST portal
 * and nothing is marked as filed.
 */
export function Gstr1Page() {
  const [tab, setTab] = useState<Tab>('gstr1');
  const periods = recentPeriods();
  const [period, setPeriod] = useState(periods[0]!.value);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['gstr1', period],
    queryFn: () => api.get<{ summary: Gstr1Summary }>('/api/gstr1/summary', { query: { period } }),
  });

  const data = summary.data?.summary;
  const nothingToFile =
    data !== undefined && data.counts.b2bInvoices + data.counts.b2clInvoices + data.counts.b2csRows === 0;

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await requestBlob('/api/gstr1/download', { query: { period } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setDownloadError('Could not produce the file. Try again in a moment.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          GST returns
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          What to file, and what it costs. Both are working papers for your CA.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
        {([
          { id: 'gstr1' as const, label: 'GSTR-1' },
          { id: 'summary' as const, label: 'Tax summary' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={[
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition',
              tab === id
                ? 'border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'summary' ? <TaxSummaryTab /> : null}

      {tab === 'gstr1' ? (
      <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">
            Outward supplies for one month, ready for the offline utility.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Return period
            </span>
            <select
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
            >
              {periods.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <Button size="lg" onClick={download} loading={downloading} disabled={!data}>
            Download JSON
          </Button>
        </div>
      </header>

      <Alert tone="info" title="Check this before you file">
        This is prepared from the bills you issued — it is not a filing, and nothing here has been
        sent to the GST portal. Tally the figures below against your own register, then give the
        downloaded file to your CA or upload it in the GST offline utility.
      </Alert>

      {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}

      {summary.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : summary.error ? (
        <ErrorAlert error={summary.error} />
      ) : data ? (
        <>
          {data.warnings.map((warning) => (
            <Alert key={warning.code} tone="warning">
              {warning.message}
            </Alert>
          ))}

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Figure label="Taxable value" value={formatMoney(data.totals.taxableValue)} strong />
            <Figure label="Total invoice value" value={formatMoney(data.totals.invoiceValue)} strong />
            <Figure
              label="Tax payable"
              value={formatMoney(
                // Displayed only — the server already rounded each head, and
                // adding three settled figures for a heading is not arithmetic
                // anything depends on.
                String(
                  Number(data.totals.cgst) + Number(data.totals.sgst) + Number(data.totals.igst),
                ),
              )}
              strong
            />
            <Figure label="CGST" value={formatMoney(data.totals.cgst)} />
            <Figure label="SGST" value={formatMoney(data.totals.sgst)} />
            <Figure label="IGST" value={formatMoney(data.totals.igst)} />
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
              What is in the return — {data.periodLabel}
            </h2>
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row
                term="B2B invoices"
                detail={`To ${data.counts.b2bCounterparties} registered ${
                  data.counts.b2bCounterparties === 1 ? 'customer' : 'customers'
                }, reported one by one`}
                value={data.counts.b2bInvoices}
              />
              <Row
                term="B2CL invoices"
                detail="Large sales to other states without a GSTIN, reported one by one"
                value={data.counts.b2clInvoices}
              />
              <Row
                term="B2CS rows"
                detail="Everything else sold without a GSTIN, as state-and-rate totals only"
                value={data.counts.b2csRows}
              />
              <Row
                term="Credit notes"
                detail="Returns and reductions, deducted from the totals above"
                value={data.counts.creditNotes}
              />
              <Row
                term="Debit notes"
                detail="Undercharges corrected after the bill"
                value={data.counts.debitNotes}
              />
              <Row
                term="HSN rows"
                detail="One per HSN code and unit, for the summary table"
                value={data.counts.hsnRows}
              />
              <Row
                term="Cancelled invoices"
                detail="Left out of the sections, but still declared in the document series"
                value={data.counts.cancelledInvoices}
              />
            </dl>
          </section>

          {nothingToFile ? (
            <p className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700">
              Nothing was sold in {data.periodLabel}. A nil return still has to be filed.
            </p>
          ) : null}

          <p className="text-xs text-slate-500">
            Filed under GSTIN <span className="font-mono">{data.gstin}</span>. The downloaded file
            is named for the portal — open it in the GST offline utility, not a spreadsheet.
          </p>
        </>
      ) : null}
      </>
      ) : null}
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`tabular mt-1 ${
          strong
            ? 'text-xl font-semibold text-slate-900 dark:text-slate-100'
            : 'text-lg text-slate-700 dark:text-slate-300'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Row({ term, detail, value }: { term: string; detail: string; value: number }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <dt className="text-sm font-medium text-slate-900 dark:text-slate-100">{term}</dt>
        <dd className="text-xs text-slate-500">{detail}</dd>
      </div>
      <dd
        className={`tabular text-lg font-semibold ${
          value === 0 ? 'text-slate-400' : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
