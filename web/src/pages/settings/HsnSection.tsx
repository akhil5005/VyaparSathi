import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate, formatPercent, todayInput } from '../../lib/money';
import type { HsnCode } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

/**
 * GST rates, by HSN code.
 *
 * Rates are **not** a field on the product. They live on the HSN with an
 * effective-from date, so when the Council revises a slab you add a new row and
 * every invoice keeps printing the rate that applied on its own date. That is
 * why this screen adds rates rather than editing them: editing would rewrite
 * the tax on invoices already filed.
 */
export function HsnSection() {
  const [changingRate, setChangingRate] = useState<HsnCode | null>(null);

  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<{ hsnCodes: HsnCode[] }>('/api/masters/hsn'),
  });

  const rows = hsn.data?.hsnCodes ?? [];
  const missingRate = rows.filter((h) => !h.currentRate);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        The rate charged on each kind of paper. Changing one adds a new rate from a date — old
        invoices keep the rate they were issued at.
      </p>

      {missingRate.length > 0 ? (
        <Alert tone="warning" title="No rate in force">
          {missingRate.map((h) => h.code).join(', ')} {missingRate.length === 1 ? 'has' : 'have'} no
          GST rate applying today. Products on {missingRate.length === 1 ? 'it' : 'them'} cannot be
          billed until a rate is added.
        </Alert>
      ) : null}

      {hsn.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5 text-slate-400" />
        </div>
      ) : hsn.error ? (
        <ErrorAlert error={hsn.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                <th className="px-4 py-2.5 font-medium">HSN</th>
                <th className="px-3 py-2.5 font-medium">Covers</th>
                <th className="px-3 py-2.5 text-right font-medium">Products</th>
                <th className="px-3 py-2.5 text-right font-medium">GST today</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((code) => (
                <tr key={code.id}>
                  <td className="px-4 py-3 font-mono text-slate-900 dark:text-slate-100">
                    {code.code}
                  </td>
                  <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
                    {code.description}
                  </td>
                  <td className="tabular px-3 py-3 text-right text-slate-500">
                    {code.productCount ?? 0}
                  </td>
                  <td className="tabular px-3 py-3 text-right">
                    {code.currentRate ? (
                      <>
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {formatPercent(code.currentRate.gstRate)}
                        </span>
                        <p className="text-xs text-slate-400">
                          from {formatDate(code.currentRate.effectiveFrom)}
                        </p>
                      </>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="secondary" onClick={() => setChangingRate(code)}>
                      Change rate
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {changingRate ? (
        <ChangeRateDialog hsn={changingRate} onClose={() => setChangingRate(null)} />
      ) : null}
    </div>
  );
}

function ChangeRateDialog({ hsn, onClose }: { hsn: HsnCode; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [gstRate, setGstRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayInput());
  const [notes, setNotes] = useState('');

  const detail = useQuery({
    queryKey: ['hsn', hsn.id],
    queryFn: () => api.get<{ hsnCode: HsnCode }>(`/api/masters/hsn/${hsn.id}`),
  });

  const addRate = useMutation({
    mutationFn: () =>
      api.post(`/api/masters/hsn/${hsn.id}/rates`, {
        gstRate,
        effectiveFrom,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['hsn'] });
      // A rate change alters what every product on this HSN bills at.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
  });

  const fieldErrors = addRate.error instanceof ApiError ? addRate.error.fieldErrors : {};
  const rate = Number(gstRate);
  const ready = gstRate !== '' && rate >= 0 && rate <= 100 && !addRate.isPending;
  const history = detail.data?.hsnCode.taxRates ?? [];

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) addRate.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`GST rate for ${hsn.code}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={addRate.isPending} disabled={!ready}>
            Add rate
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={addRate.error} />

        <p className="text-sm text-slate-600 dark:text-slate-400">{hsn.description}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="New GST rate"
            value={gstRate}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setGstRate(v);
            }}
            error={fieldErrors['gstRate']}
            inputMode="decimal"
            hint="Combined — split 50/50 into CGST and SGST"
            className="tabular"
            required
            autoFocus
            placeholder="18"
          />
          <Field
            label="Applies from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            error={fieldErrors['effectiveFrom']}
            required
          />
        </div>

        <Field
          label="Note"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          hint="Optional — e.g. the notification number"
        />

        <Alert tone="info">
          This adds a rate rather than replacing one. Invoices already issued keep the rate they
          were billed at, which is what a reprint and a filed return both need.
        </Alert>

        {history.length > 0 ? (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Rate history
            </h3>
            <ul className="space-y-0.5 text-sm">
              {history.map((entry) => (
                <li key={entry.id} className="flex justify-between gap-3">
                  <span className="text-slate-600 dark:text-slate-400">
                    {formatDate(entry.effectiveFrom)}
                    {entry.effectiveTo ? ` – ${formatDate(entry.effectiveTo)}` : ' – now'}
                  </span>
                  <span className="tabular text-slate-900 dark:text-slate-100">
                    {formatPercent(entry.gstRate)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
