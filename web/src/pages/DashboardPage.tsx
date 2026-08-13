import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatMoney, formatQuantity } from '../lib/money';
import type { OutstandingResponse, Product, SalesInvoice } from '../lib/types';
import { useAuth } from '../auth/AuthProvider';
import { Spinner } from '../components/Spinner';
import { ErrorAlert } from '../components/Alert';

/**
 * What the shop needs to know on opening.
 *
 * Three questions, in the order they get asked: how much did we sell, who owes
 * us money, and what are we about to run out of.
 */
export function DashboardPage() {
  const { user } = useAuth();

  const outstanding = useQuery({
    queryKey: ['outstanding'],
    queryFn: () =>
      api.get<OutstandingResponse>(
        '/api/payments/outstanding',
      ),
  });

  const recent = useQuery({
    queryKey: ['invoices', 'recent'],
    queryFn: () =>
      api.get<{ invoices: SalesInvoice[] }>('/api/sales-invoices', {
        query: { pageSize: 8 },
      }),
  });

  const lowStock = useQuery({
    queryKey: ['products', 'low-stock'],
    queryFn: () =>
      api.get<{ products: Product[] }>('/api/masters/products', {
        query: { lowStockOnly: true, pageSize: 8 },
      }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {greeting()}, {user?.fullName.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Here's where the shop stands today.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total outstanding"
          value={formatMoney(outstanding.data?.grandTotal.total)}
          detail={`${outstanding.data?.parties.length ?? 0} customers`}
          loading={outstanding.isLoading}
          tone={Number(outstanding.data?.grandTotal.total ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Overdue past 90 days"
          value={formatMoney(outstanding.data?.grandTotal.over90)}
          detail="Chase these first"
          loading={outstanding.isLoading}
          tone={Number(outstanding.data?.grandTotal.over90 ?? 0) > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Low on stock"
          value={String(lowStock.data?.products.length ?? 0)}
          detail="At or below reorder level"
          loading={lowStock.isLoading}
          tone={(lowStock.data?.products.length ?? 0) > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Recent bills" href="/invoices" linkLabel="All invoices">
          {recent.isLoading ? (
            <PanelSpinner />
          ) : recent.error ? (
            <ErrorAlert error={recent.error} />
          ) : !recent.data?.invoices.length ? (
            <Empty>
              No bills yet.{' '}
              <Link to="/billing" className="font-medium underline underline-offset-4">
                Make the first one
              </Link>
              .
            </Empty>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.data.invoices.map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {invoice.partyName}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {invoice.invoiceNumber ?? 'Draft'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatMoney(invoice.grandTotal)}
                    </p>
                    {Number(invoice.amountPaid) < Number(invoice.grandTotal) ? (
                      <p className="text-xs text-amber-600 dark:text-amber-400">Unpaid</p>
                    ) : (
                      <p className="text-xs text-emerald-600 dark:text-emerald-400">Paid</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Who owes the most" href="/payments" linkLabel="Full udhaar report">
          {outstanding.isLoading ? (
            <PanelSpinner />
          ) : outstanding.error ? (
            <ErrorAlert error={outstanding.error} />
          ) : !outstanding.data?.parties.length ? (
            <Empty>Nothing outstanding. Everyone has paid.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {outstanding.data.parties.slice(0, 8).map((party) => (
                <li key={party.partyId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {party.partyName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {party.invoiceCount} bill{party.invoiceCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <p className="tabular text-sm font-medium text-slate-900 dark:text-slate-100">
                    {formatMoney(party.ageing.total)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {lowStock.data?.products.length ? (
        <Panel title="Running low" href="/products" linkLabel="All products">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {lowStock.data.products.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {product.name}
                </p>
                <p className="tabular shrink-0 text-sm text-amber-600 dark:text-amber-400">
                  {formatQuantity(product.stock?.quantityOnHand)} left
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function StatCard({
  label,
  value,
  detail,
  loading,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  loading: boolean;
  tone: 'neutral' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-slate-900 dark:text-slate-100',
    warning: 'text-amber-600 dark:text-amber-400',
    danger: 'text-rose-600 dark:text-rose-400',
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm text-slate-500">{label}</p>
      {loading ? (
        <div className="mt-2 h-8 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      ) : (
        <p className={`tabular mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
      )}
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function Panel({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <Link
          to={href}
          className="text-sm text-slate-500 underline-offset-4 hover:underline hover:text-slate-900 dark:hover:text-slate-100"
        >
          {linkLabel}
        </Link>
      </div>
      {children}
    </section>
  );
}

const PanelSpinner = () => (
  <div className="flex justify-center py-8">
    <Spinner className="h-5 w-5 text-slate-400" />
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-8 text-center text-sm text-slate-500">{children}</p>
);
