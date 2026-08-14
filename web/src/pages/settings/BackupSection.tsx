import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, requestBlob } from '../../lib/api';
import { formatDate } from '../../lib/money';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';

interface BackupSummary {
  counts: {
    users: number;
    parties: number;
    products: number;
    salesInvoices: number;
    purchaseInvoices: number;
    notes: number;
    payments: number;
    ledgerEntries: number;
    stockMovements: number;
  };
  latestInvoice: { number: string | null; date: string } | null;
}

/**
 * Taking a copy of the books.
 *
 * The books *are* the business. A disk dies, a laptop is stolen, a hosting
 * account lapses — and years of ledger go with it. This is the version of a
 * backup that will actually get taken, because it is a button rather than a
 * command line.
 *
 * The counts are shown before the download deliberately. The classic backup
 * failure is discovering on the day you need it that the file was empty all
 * along, and the only defence is seeing the numbers before you trust them.
 */
export function BackupSection() {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [takenAt, setTakenAt] = useState<Date | null>(null);

  const summary = useQuery({
    queryKey: ['backup', 'summary'],
    queryFn: () => api.get<BackupSummary>('/api/backup/summary'),
  });

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await requestBlob('/api/backup/download');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setTakenAt(new Date());
    } catch {
      setDownloadError('Could not produce the backup. Try again in a moment.');
    } finally {
      setDownloading(false);
    }
  }

  const c = summary.data?.counts;

  return (
    <div className="max-w-2xl space-y-5">
      <section>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Download a copy of everything
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          One file with every customer, product, bill, payment and ledger entry. Keep it somewhere
          that is not this computer — a pen drive, or your own email to yourself.
        </p>
      </section>

      {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}
      {takenAt ? (
        <Alert tone="success">
          Backup taken at {takenAt.toLocaleTimeString('en-IN')}. Check it actually saved, then put a
          copy somewhere else.
        </Alert>
      ) : null}

      {summary.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : summary.error ? (
        <ErrorAlert error={summary.error} />
      ) : c ? (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <h3 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
              What the file will contain
            </h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-3">
              <Count label="Sales bills" value={c.salesInvoices} />
              <Count label="Purchase bills" value={c.purchaseInvoices} />
              <Count label="Credit / debit notes" value={c.notes} />
              <Count label="Payments" value={c.payments} />
              <Count label="Customers & suppliers" value={c.parties} />
              <Count label="Products" value={c.products} />
              <Count label="Ledger entries" value={c.ledgerEntries} />
              <Count label="Stock movements" value={c.stockMovements} />
              <Count label="Staff accounts" value={c.users} />
            </dl>
            {summary.data?.latestInvoice ? (
              <p className="border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
                Most recent bill: {summary.data.latestInvoice.number} dated{' '}
                {formatDate(summary.data.latestInvoice.date)}
              </p>
            ) : null}
          </div>

          <Button size="lg" onClick={download} loading={downloading}>
            Download backup
          </Button>
        </>
      ) : null}

      <Alert tone="info" title="What this does and does not cover">
        <ul className="ml-4 list-disc space-y-1">
          <li>
            Passwords are <strong>not</strong> in the file. That is on purpose — it gets emailed and
            copied around, and a backup that leaks logins is worse than none. Restoring sets a
            fresh owner password.
          </li>
          <li>
            It is read across several queries, so a bill issued while it runs could land half in.
            Take it when the counter is quiet.
          </li>
          <li>
            Putting it back is a command, not a button:{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">
              npx tsx scripts/restore-backup.ts &lt;file&gt; --owner-password "…"
            </code>{' '}
            against an empty database. Worth trying once now, while nothing depends on it.
          </li>
        </ul>
      </Alert>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <dt className="text-xs text-slate-500">{label}</dt>
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
