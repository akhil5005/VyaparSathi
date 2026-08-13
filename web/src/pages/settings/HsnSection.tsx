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
  const [adding, setAdding] = useState(false);

  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<{ hsnCodes: HsnCode[] }>('/api/masters/hsn'),
  });

  const rows = hsn.data?.hsnCodes ?? [];
  const missingRate = rows.filter((h) => !h.currentRate);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-500">
          The rate charged on each kind of paper. Changing one adds a new rate from a date — old
          invoices keep the rate they were issued at.
        </p>
        <Button onClick={() => setAdding(true)}>Add HSN code</Button>
      </div>

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
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500">No HSN codes yet.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            Every product needs one — it is what decides the GST rate on a bill. Paper is
            Chapter 48: 4802 for copier and writing paper, 4810 for coated, 4820 for registers.
          </p>
          <div className="mt-4">
            <Button onClick={() => setAdding(true)}>Add the first one</Button>
          </div>
        </div>
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

      {adding ? <AddHsnDialog onClose={() => setAdding(false)} /> : null}

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

/// The paper trade's chapter, offered as one-click starting points. Typing
/// "4802" from memory is fine; picking it from a list nobody has to remember
/// is better, and the description is what appears in the product form.
const COMMON_PAPER_HSN: { code: string; description: string }[] = [
  { code: '4802', description: 'Uncoated paper for writing/printing (A4, copier, printing paper)' },
  { code: '4801', description: 'Newsprint, in rolls or sheets' },
  { code: '4805', description: 'Other uncoated paper and paperboard' },
  { code: '4810', description: 'Coated paper and paperboard (art paper, chromo)' },
  { code: '4817', description: 'Envelopes, letter cards, plain postcards' },
  { code: '4820', description: 'Registers, notebooks, letter pads, files' },
  { code: '4823', description: 'Other paper cut to size (tissue, wrapping)' },
];

/**
 * Adding an HSN code, with its first rate.
 *
 * Both in one step deliberately. An HSN with no rate in force cannot be billed
 * against, so creating one without a rate produces a product that looks fine
 * until someone tries to sell it — a failure discovered at the counter with a
 * customer waiting.
 */
function AddHsnDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [gstRate, setGstRate] = useState('18');
  // Backdated to the start of the current financial year so an invoice entered
  // late — for a sale that happened in April — still finds a rate.
  const [effectiveFrom, setEffectiveFrom] = useState(financialYearStart());

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/masters/hsn', {
        code: code.trim(),
        description: description.trim(),
        gstRate,
        effectiveFrom,
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['hsn'] });
      onClose();
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const rate = Number(gstRate);
  const ready =
    /^\d{4,8}$/.test(code.trim()) &&
    description.trim().length >= 2 &&
    gstRate !== '' &&
    rate >= 0 &&
    rate <= 100 &&
    !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  const unused = COMMON_PAPER_HSN.filter((h) => h.code !== code.trim());

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add HSN code"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={create.error} />

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            Common for paper
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unused.map((option) => (
              <button
                key={option.code}
                type="button"
                onClick={() => {
                  setCode(option.code);
                  setDescription(option.description);
                }}
                className="rounded-lg border border-slate-300 px-2.5 py-1 font-mono text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {option.code}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Tap one to fill it in, or type any code below.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field
            label="Code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            error={fieldErrors['code']}
            inputMode="numeric"
            hint="4 to 8 digits"
            className="font-mono"
            required
            autoFocus
            placeholder="4802"
          />
          <Field
            label="What it covers"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={fieldErrors['description']}
            hint="Shown when picking an HSN for a product"
            required
            placeholder="Uncoated paper for writing/printing"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="GST rate"
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
          />
          <Field
            label="Applies from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            error={fieldErrors['effectiveFrom']}
            hint="Backdated to this financial year"
            required
          />
        </div>

        <Alert tone="info">
          Confirm the rate with your accountant before billing. An HSN with no rate in force
          cannot be sold against at all, so the rate is set here rather than left for later.
        </Alert>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/// 1 April of the current Indian financial year, as a yyyy-mm-dd input value.
function financialYearStart(): string {
  const now = new Date();
  const year = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}
