import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/money';
import type {
  ChequeListResponse,
  OutstandingResponse,
  PaymentDirection,
  PaymentListResponse,
} from '../../lib/types';
import { Button } from '../../components/Button';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { RecordPaymentDialog } from './RecordPaymentDialog';
import { OutstandingTable } from './OutstandingTable';
import { ChequeList } from './ChequeList';
import { PaymentList } from './PaymentList';
import { Pagination, usePage } from '../../components/Pagination';

/// One screenful. Small enough to scan, large enough that paging is rare.
const PAGE_SIZE = 25;

/**
 * Money moving, and who still owes it.
 *
 * Three views of the same question, because a shopkeeper asks it three ways:
 * *who owes me* (the udhaar report, the reason this screen exists), *what moved
 * today* (the payment list, both directions), and *which cheques can I bank*
 * (the cheque list, where a post-dated cheque sits until its date arrives).
 *
 * The ageing buckets above the tabs are receivables only. Money owed *to*
 * suppliers is not aged here — a supplier chases you by telephone, not by
 * report, and inventing a payables ageing screen nobody asked for would be
 * three columns of zeroes for this shop.
 */

type Tab = 'outstanding' | 'payments' | 'cheques';

const TABS: { id: Tab; label: string }[] = [
  { id: 'outstanding', label: 'Who owes (udhaar)' },
  { id: 'payments', label: 'Payments' },
  { id: 'cheques', label: 'Cheques' },
];

export function PaymentsPage() {
  const [tab, setTab] = useState<Tab>('outstanding');
  // A page each: switching tabs should not carry page four across to a list
  // that has two pages.
  const [paymentsPage, setPaymentsPage] = usePage([tab]);
  const [chequesPage, setChequesPage] = usePage([tab]);
  const [recording, setRecording] = useState<{
    partyId?: string;
    partyName?: string;
    direction?: PaymentDirection;
    lockDirection?: boolean;
  } | null>(null);

  const outstanding = useQuery({
    queryKey: ['outstanding'],
    queryFn: () => api.get<OutstandingResponse>('/api/payments/outstanding'),
  });

  const payments = useQuery({
    queryKey: ['payments', 'list', paymentsPage],
    queryFn: () =>
      api.get<PaymentListResponse>('/api/payments', {
        query: { page: paymentsPage, pageSize: PAGE_SIZE },
      }),
    enabled: tab === 'payments',
  });

  const cheques = useQuery({
    queryKey: ['cheques', 'list', chequesPage],
    queryFn: () =>
      api.get<ChequeListResponse>('/api/payments/cheques', {
        query: { page: chequesPage, pageSize: PAGE_SIZE },
      }),
    enabled: tab === 'cheques',
  });

  const total = outstanding.data?.grandTotal;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Payments &amp; udhaar
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Record money in and out, and see who still owes.
          </p>
        </div>
        {/* Two buttons rather than one with a toggle inside: taking cash at the
            counter is the common act and should stay one tap, while paying a
            mill is deliberate enough to deserve naming itself. */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            variant="secondary"
            onClick={() => setRecording({ direction: 'PAYMENT' })}
          >
            Pay a supplier
          </Button>
          <Button size="lg" onClick={() => setRecording({ direction: 'RECEIPT' })}>
            Record payment
          </Button>
        </div>
      </header>

      {/* The ageing summary, always visible — it is the number he cares about. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Bucket label="Total owed" value={total?.total} tone="total" loading={outstanding.isLoading} />
        <Bucket label="0–30 days" value={total?.current} loading={outstanding.isLoading} />
        <Bucket label="31–60 days" value={total?.days31to60} loading={outstanding.isLoading} />
        <Bucket label="61–90 days" value={total?.days61to90} tone="warn" loading={outstanding.isLoading} />
        <Bucket label="Over 90 days" value={total?.over90} tone="bad" loading={outstanding.isLoading} />
      </div>

      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
        {TABS.map(({ id, label }) => (
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

      {tab === 'outstanding' ? (
        <Section query={outstanding}>
          <OutstandingTable
            parties={outstanding.data?.parties ?? []}
            asOf={outstanding.data?.asOf}
            onCollect={(party) =>
              setRecording({
                partyId: party.partyId,
                partyName: party.partyName,
                // Collecting from a named debtor is unambiguously money in.
                direction: 'RECEIPT',
                lockDirection: true,
              })
            }
          />
        </Section>
      ) : null}

      {tab === 'payments' ? (
        <Section query={payments}>
          <PaymentList
            payments={payments.data?.payments ?? []}
            totalAmount={payments.data?.totalAmount}
            totalOnAccount={payments.data?.totalOnAccount}
          />
          <Pagination
            page={payments.data?.page ?? paymentsPage}
            pageSize={payments.data?.pageSize ?? PAGE_SIZE}
            total={payments.data?.total ?? 0}
            onPage={setPaymentsPage}
            noun="payments"
          />
        </Section>
      ) : null}

      {tab === 'cheques' ? (
        <Section query={cheques}>
          <ChequeList cheques={cheques.data?.cheques ?? []} />
          <Pagination
            page={cheques.data?.page ?? chequesPage}
            pageSize={cheques.data?.pageSize ?? PAGE_SIZE}
            total={cheques.data?.total ?? 0}
            onPage={setChequesPage}
            noun="cheques"
          />
        </Section>
      ) : null}

      {recording ? (
        <RecordPaymentDialog
          presetPartyId={recording.partyId}
          presetPartyName={recording.partyName}
          initialDirection={recording.direction}
          lockDirection={recording.lockDirection}
          onClose={() => setRecording(null)}
        />
      ) : null}
    </div>
  );
}

function Section({
  query,
  children,
}: {
  query: { isLoading: boolean; error: unknown };
  children: React.ReactNode;
}) {
  if (query.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6 text-slate-400" />
      </div>
    );
  }
  if (query.error) return <ErrorAlert error={query.error} />;
  return <>{children}</>;
}

function Bucket({
  label,
  value,
  tone = 'plain',
  loading,
}: {
  label: string;
  value: string | undefined;
  tone?: 'plain' | 'total' | 'warn' | 'bad';
  loading: boolean;
}) {
  // Colour means "look at this". A red ₹0.00 in the 90-day bucket is an alarm
  // about nothing, and a screen that cries wolf gets ignored — so the warning
  // tones only apply once there is actually money in the bucket.
  const empty = Number(value ?? 0) === 0;
  const toneClass = empty
    ? 'text-slate-400 dark:text-slate-600'
    : {
        plain: 'text-slate-900 dark:text-slate-100',
        total: 'text-slate-900 dark:text-slate-100',
        warn: 'text-amber-600 dark:text-amber-400',
        bad: 'text-rose-600 dark:text-rose-400',
      }[tone];

  return (
    <div
      className={[
        'rounded-xl border p-3',
        tone === 'total'
          ? 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
      ].join(' ')}
    >
      <p className="text-xs text-slate-500">{label}</p>
      {loading ? (
        <div className="mt-1.5 h-6 w-20 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      ) : (
        <p className={`tabular mt-0.5 text-lg font-semibold ${toneClass}`}>{formatMoney(value)}</p>
      )}
    </div>
  );
}

export { formatDate };
