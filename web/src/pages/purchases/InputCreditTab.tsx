import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/money';
import type { PendingItcPurchase, PendingItcResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { recentPeriods } from '../returns/periods';

/**
 * Input tax credit — the GST already paid to suppliers, offset against the GST
 * collected from customers.
 *
 * This is money, and it was the largest thing the app could record but not let
 * anyone use: `itc/pending` and `itc/claim` existed and were tested, with zero
 * callers in the web app. A bill's credit sat unclaimed until somebody worked
 * it out on paper.
 *
 * Claiming here is **bookkeeping, not filing**. It records what the CA put on
 * the return, so next month's "what haven't I claimed?" is accurate. Nothing
 * talks to the GST portal, and marking a bill claimed does not claim anything
 * — the return does that.
 */
export function InputCreditTab() {
  const queryClient = useQueryClient();
  const periods = recentPeriods();

  const [period, setPeriod] = useState(periods[0]!.value);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [claimed, setClaimed] = useState<number | null>(null);

  const pending = useQuery({
    queryKey: ['purchases', 'itc', 'pending'],
    queryFn: () => api.get<PendingItcResponse>('/api/purchases/itc/pending'),
  });

  const rows = pending.data?.purchases ?? [];

  const claim = useMutation({
    mutationFn: () =>
      api.post<{ claimed: number }>('/api/purchases/itc/claim', {
        period,
        purchaseIds: [...selected],
      }),
    async onSuccess() {
      setClaimed(selected.size);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    },
  });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const selectedCredit = rows
    .filter((row) => selected.has(row.id))
    // Displayed only. The server recomputes what is actually claimed, and its
    // figure is the one that counts.
    .reduce((total, row) => total + Number(row.creditAvailable), 0);

  if (pending.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6 text-slate-400" />
      </div>
    );
  }
  if (pending.error) return <ErrorAlert error={pending.error} />;

  return (
    <div className="space-y-4">
      {claimed !== null ? (
        <Alert tone="success">
          Marked {claimed} bill{claimed === 1 ? '' : 's'} as claimed in {periodLabel(periods, period)}.
          Make sure your CA has put the same figure on the return.
        </Alert>
      ) : null}

      <ErrorAlert error={claim.error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure
          label="Credit waiting to be claimed"
          value={formatMoney(pending.data?.totalCredit)}
          strong
        />
        <Figure label="CGST + SGST" value={formatMoney(
          String(Number(pending.data?.heads.cgst ?? 0) + Number(pending.data?.heads.sgst ?? 0)),
        )} />
        <Figure label="IGST" value={formatMoney(pending.data?.heads.igst)} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
          Every eligible bill has had its credit claimed. Nothing on the table.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                    <th className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                        }
                        aria-label="Select every bill"
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Supplier bill</th>
                    <th className="px-3 py-2.5 font-medium">Supplier</th>
                    <th className="px-3 py-2.5 text-right font-medium">Taxable</th>
                    <th className="px-4 py-2.5 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((row) => (
                    <Row
                      key={row.id}
                      purchase={row}
                      checked={selected.has(row.id)}
                      onToggle={() => toggle(row.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Claimed in return period
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
              <p className="mt-1.5 text-sm text-slate-500">
                {selected.size === 0
                  ? 'Tick the bills your CA put on that return.'
                  : `${selected.size} bill${selected.size === 1 ? '' : 's'} · ${formatMoney(String(selectedCredit))} of credit`}
              </p>
            </div>

            <Button
              size="lg"
              onClick={() => claim.mutate()}
              loading={claim.isPending}
              disabled={selected.size === 0}
            >
              Mark as claimed
            </Button>
          </div>
        </>
      )}

      <Alert tone="info" title="This records, it does not file">
        Marking a bill claimed is bookkeeping — it is how this app knows which credit is still
        outstanding. It does not send anything to the GST portal and does not claim anything by
        itself. Do it after your CA has filed, matching what actually went on the return.
      </Alert>
    </div>
  );
}

const periodLabel = (periods: { value: string; label: string }[], value: string) =>
  periods.find((p) => p.value === value)?.label ?? value;

function Row({
  purchase,
  checked,
  onToggle,
}: {
  purchase: PendingItcPurchase;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr
      onClick={onToggle}
      className={`cursor-pointer ${checked ? 'bg-slate-50 dark:bg-slate-800/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'}`}
    >
      <td className="px-4 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${purchase.supplierInvoiceNumber}`}
          className="h-4 w-4 rounded border-slate-300"
        />
      </td>

      <td className="px-3 py-3">
        <p className="font-medium text-slate-900 dark:text-slate-100">
          {purchase.supplierInvoiceNumber}
        </p>
        <p className="text-xs text-slate-500">
          {formatDate(purchase.supplierInvoiceDate)} · our ref {purchase.purchaseNumber}
        </p>
      </td>

      <td className="px-3 py-3">
        <p className="text-slate-700 dark:text-slate-300">{purchase.partyName}</p>
        {/* No GSTIN means the supplier never reported it, so the credit will
            not appear in GSTR-2B and is likely to be disallowed. */}
        <p className="font-mono text-xs text-slate-500">
          {purchase.partyGstin ?? 'No GSTIN — credit may be disallowed'}
        </p>
      </td>

      <td className="tabular px-3 py-3 text-right text-slate-600 dark:text-slate-400">
        {formatMoney(purchase.taxableValue)}
      </td>

      <td className="tabular px-4 py-3 text-right font-medium text-emerald-700 dark:text-emerald-400">
        {formatMoney(purchase.creditAvailable)}
      </td>
    </tr>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`tabular mt-1 ${
          strong
            ? 'text-xl font-semibold text-emerald-700 dark:text-emerald-400'
            : 'text-lg text-slate-700 dark:text-slate-300'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
