import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pagination, usePage } from '../../components/Pagination';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/money';
import type { PendingItcResponse, PurchaseListResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { NewPurchaseDialog } from './NewPurchaseDialog';

/// One screenful. Small enough to scan, large enough that paging is rare.
const PAGE_SIZE = 25;

/**
 * Supplier bills, and the credit they carry.
 *
 * Two jobs. Entering a bill is what sets the moving-average cost — a sale's
 * margin is only as honest as the purchase behind it. And the GST on that bill
 * is money the government owes back, which is only reclaimable once it is
 * recorded and claimed in a return period, so unclaimed credit sitting here is
 * cash left on the table.
 */
export function PurchasesPage() {
  const [entering, setEntering] = useState(false);
  const [page, setPage] = usePage([]);

  const purchases = useQuery({
    queryKey: ['purchases', 'list', page],
    queryFn: () => api.get<PurchaseListResponse>('/api/purchases', { query: { page, pageSize: PAGE_SIZE } }),
  });

  const pendingItc = useQuery({
    queryKey: ['purchases', 'itc', 'pending'],
    queryFn: () => api.get<PendingItcResponse>('/api/purchases/itc/pending'),
  });

  const rows = purchases.data?.purchases ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Purchases
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Supplier bills. Entering one updates the cost of that stock.
          </p>
        </div>
        <Button size="lg" onClick={() => setEntering(true)}>
          Enter supplier bill
        </Button>
      </header>

      {Number(pendingItc.data?.totalCredit ?? 0) > 0 ? (
        <Alert tone="info" title="Input credit not yet claimed">
          {formatMoney(pendingItc.data!.totalCredit)} of GST across{' '}
          {pendingItc.data!.count} bill{pendingItc.data!.count === 1 ? '' : 's'} has not been
          claimed in a return period. Your CA claims this when filing — it is money back, so it is
          worth checking nothing is missed.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Total purchased" value={purchases.data?.totalValue} loading={purchases.isLoading} />
        <Stat label="Taxable value" value={purchases.data?.totalTaxable} loading={purchases.isLoading} />
        <Stat
          label="Credit awaiting claim"
          value={pendingItc.data?.totalCredit}
          loading={pendingItc.isLoading}
          tone={Number(pendingItc.data?.totalCredit ?? 0) > 0 ? 'good' : 'plain'}
        />
      </div>

      {purchases.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : purchases.error ? (
        <ErrorAlert error={purchases.error} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
          No supplier bills entered yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Supplier bill</th>
                  <th className="px-3 py-2.5 font-medium">Supplier</th>
                  <th className="px-3 py-2.5 text-right font-medium">Taxable</th>
                  <th className="px-3 py-2.5 text-right font-medium">GST</th>
                  <th className="px-3 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Credit</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((purchase) => {
                  const gst =
                    Number(purchase.totalCgst) +
                    Number(purchase.totalSgst) +
                    Number(purchase.totalIgst);
                  const cancelled = purchase.status === 'CANCELLED';

                  return (
                    <tr
                      key={purchase.id}
                      className={cancelled ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}
                    >
                      <td className="px-4 py-3">
                        <p
                          className={`font-mono text-xs text-slate-900 dark:text-slate-100 ${cancelled ? 'line-through' : ''}`}
                        >
                          {purchase.supplierInvoiceNumber}
                        </p>
                        <p className="text-xs text-slate-500">
                          {formatDate(purchase.supplierInvoiceDate)}
                          {purchase.purchaseNumber ? ` · ${purchase.purchaseNumber}` : ''}
                        </p>
                      </td>

                      <td className="px-3 py-3 text-slate-900 dark:text-slate-100">
                        {purchase.party?.displayName ?? purchase.partyName}
                      </td>

                      <td className="tabular px-3 py-3 text-right text-slate-700 dark:text-slate-300">
                        {formatMoney(purchase.taxableValue)}
                      </td>

                      <td className="tabular px-3 py-3 text-right text-slate-600 dark:text-slate-400">
                        {formatMoney(String(gst))}
                      </td>

                      <td className="tabular px-3 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(purchase.grandTotal)}
                      </td>

                      <td className="px-4 py-3">
                        {!purchase.itcEligible ? (
                          <Badge tone="muted">Not eligible</Badge>
                        ) : purchase.itcClaimed ? (
                          <Badge tone="good">
                            Claimed{purchase.itcClaimedPeriod ? ` ${purchase.itcClaimedPeriod}` : ''}
                          </Badge>
                        ) : (
                          <Badge tone="pending">Unclaimed</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={purchases.data?.page ?? page}
            pageSize={purchases.data?.pageSize ?? PAGE_SIZE}
            total={purchases.data?.total ?? 0}
            onPage={setPage}
            noun="bills"
          />
        </div>
      )}

      {entering ? <NewPurchaseDialog onClose={() => setEntering(false)} /> : null}
    </div>
  );
}

function Stat({
  label,
  value,
  loading,
  tone = 'plain',
}: {
  label: string;
  value: string | undefined;
  loading: boolean;
  tone?: 'plain' | 'good';
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500">{label}</p>
      {loading ? (
        <div className="mt-1.5 h-6 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      ) : (
        <p
          className={[
            'tabular mt-0.5 text-lg font-semibold',
            tone === 'good'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-slate-900 dark:text-slate-100',
          ].join(' ')}
        >
          {formatMoney(value)}
        </p>
      )}
    </div>
  );
}

function Badge({ tone, children }: { tone: 'good' | 'pending' | 'muted'; children: React.ReactNode }) {
  const style = {
    good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
    muted: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  }[tone];

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {children}
    </span>
  );
}
