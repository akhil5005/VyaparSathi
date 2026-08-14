import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatDate, formatMoney, todayInput } from '../../lib/money';
import type { InvoiceStatus, SalesInvoiceListResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { InvoiceDetailDialog } from './InvoiceDetailDialog';
import { Pagination, usePage } from '../../components/Pagination';

/**
 * Every bill ever raised.
 *
 * Billing prints an invoice at the moment it is made; this is for afterwards —
 * a customer ringing about a bill from last month, a reprint, a cancellation, or
 * the CA asking what was sold in a period. Nothing here can edit an issued
 * invoice, because nothing should: it is a numbered legal document, and the only
 * way to undo one is a cancellation that leaves the number spent.
 */

/// One screenful. Small enough to scan, large enough that paging is rare.
const PAGE_SIZE = 25;

const STATUS_FILTERS: { id: InvoiceStatus | 'ALL' | 'UNPAID'; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'UNPAID', label: 'Unpaid' },
  { id: 'ISSUED', label: 'Issued' },
  { id: 'DRAFT', label: 'Drafts' },
  { id: 'CANCELLED', label: 'Cancelled' },
];

export function InvoicesPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InvoiceStatus | 'ALL' | 'UNPAID'>('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search);
  const [page, setPage] = usePage([debouncedSearch, filter, fromDate, toDate]);

  const invoices = useQuery({
    queryKey: ['invoices', 'list', debouncedSearch, filter, fromDate, toDate, page],
    queryFn: () =>
      api.get<SalesInvoiceListResponse>('/api/sales-invoices', {
        query: {
          search: debouncedSearch || undefined,
          // "Unpaid" is a balance filter, not a status one — an issued invoice
          // with money still owing.
          status: filter === 'ALL' || filter === 'UNPAID' ? undefined : filter,
          unpaidOnly: filter === 'UNPAID' || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
  });

  const rows = invoices.data?.invoices ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Invoices
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {invoices.data
            ? `${invoices.data.total} invoice${invoices.data.total === 1 ? '' : 's'}`
            : ' '}
        </p>
      </header>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={[
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition',
                filter === id
                  ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Invoice number or customer…"
            className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
          />
          <DateFilter label="From" value={fromDate} onChange={setFromDate} />
          <DateFilter label="To" value={toDate} onChange={setToDate} />
          {fromDate || toDate || search || filter !== 'ALL' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setFilter('ALL');
                setFromDate('');
                setToDate('');
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {invoices.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : invoices.error ? (
        <ErrorAlert error={invoices.error} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
          No invoices match that.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Invoice</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 text-right font-medium">Total</th>
                  <th className="px-3 py-2.5 text-right font-medium">Due</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((invoice) => {
                  const cancelled = invoice.status === 'CANCELLED';
                  const due = Number(invoice.amountDue);
                  const overdue =
                    due > 0 && invoice.dueDate !== null && invoice.dueDate < todayInput();

                  return (
                    <tr
                      key={invoice.id}
                      onClick={() => setOpenId(invoice.id)}
                      tabIndex={0}
                      role="button"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpenId(invoice.id);
                        }
                      }}
                      className={[
                        'cursor-pointer focus:outline-none',
                        cancelled
                          ? 'opacity-50'
                          : 'hover:bg-slate-50 focus:bg-slate-50 dark:hover:bg-slate-800/40 dark:focus:bg-slate-800/40',
                      ].join(' ')}
                    >
                      <td className="px-4 py-3">
                        <p
                          className={`font-mono text-xs text-slate-900 dark:text-slate-100 ${cancelled ? 'line-through' : ''}`}
                        >
                          {invoice.invoiceNumber ?? 'Draft'}
                        </p>
                        <p className="text-xs text-slate-500">{formatDate(invoice.invoiceDate)}</p>
                      </td>

                      <td className="px-3 py-3 text-slate-900 dark:text-slate-100">
                        {invoice.partyName}
                      </td>

                      <td className="tabular px-3 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(invoice.grandTotal)}
                      </td>

                      <td className="tabular px-3 py-3 text-right">
                        {cancelled ? (
                          <span className="text-slate-300 dark:text-slate-700">—</span>
                        ) : due > 0 ? (
                          <span
                            className={
                              overdue
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-amber-600 dark:text-amber-400'
                            }
                          >
                            {formatMoney(invoice.amountDue)}
                          </span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">Paid</span>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <StatusBadge status={invoice.status} overdue={overdue} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={invoices.data?.page ?? page}
            pageSize={invoices.data?.pageSize ?? PAGE_SIZE}
            total={invoices.data?.total ?? 0}
            onPage={setPage}
            noun="invoices"
          />
        </div>
      )}

      {openId ? (
        <InvoiceDetailDialog invoiceId={openId} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  );
}

function StatusBadge({ status, overdue }: { status: InvoiceStatus; overdue: boolean }) {
  const [label, style] =
    status === 'CANCELLED'
      ? ['Cancelled', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400']
      : status === 'DRAFT'
        ? ['Draft', 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300']
        : overdue
          ? ['Overdue', 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300']
          : ['Issued', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'];

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
      />
    </label>
  );
}
