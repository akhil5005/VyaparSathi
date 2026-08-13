import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatDate, formatMoney, formatQuantity } from '../../lib/money';
import type {
  CreditableResponse,
  NotePreviewResponse,
  NoteReason,
  SalesInvoiceListItem,
  SalesInvoiceListResponse,
} from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Combobox, type ComboboxHandle } from '../../components/Combobox';
import { Spinner } from '../../components/Spinner';
import { CREDIT_NOTE_REASONS, reasonOption } from './reasons';

/**
 * Raising a credit note against an invoice.
 *
 * Two things this form exists to prevent.
 *
 * **Crediting more than was sold.** The server caps each line at what remains
 * creditable — invoiced minus everything already credited on earlier notes —
 * and rejects the rest. Showing that ceiling and capping the input means a
 * double return is impossible to type, rather than failing on submit after the
 * customer has been told it is done.
 *
 * **Picking a reason that moves the wrong things.** A return puts stock back;
 * a short delivery or a rate correction does not, because the goods never left.
 * Each reason says which it is, and the preview confirms what the server
 * decided before anything is written.
 */
export function NewCreditNoteDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [invoice, setInvoice] = useState<SalesInvoiceListItem | null>(null);
  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [reason, setReason] = useState<NoteReason>('SALES_RETURN');
  const [reasonNote, setReasonNote] = useState('');
  /// Quantity being credited, keyed by invoice line id. Strings: what was typed.
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const invoiceBox = useRef<ComboboxHandle>(null);
  const debouncedInvoice = useDebounced(invoiceQuery);
  const invoicePending = invoiceQuery.trim() !== debouncedInvoice.trim();

  const invoices = useQuery({
    queryKey: ['invoices', 'search', debouncedInvoice],
    queryFn: () =>
      api.get<SalesInvoiceListResponse>('/api/sales-invoices', {
        query: { search: debouncedInvoice, status: 'ISSUED', pageSize: 8 },
      }),
    enabled: debouncedInvoice.trim().length > 0,
  });

  const creditable = useQuery({
    queryKey: ['creditable', invoice?.id],
    queryFn: () => api.get<CreditableResponse>(`/api/notes/creditable/${invoice!.id}`),
    enabled: Boolean(invoice),
  });

  const lines = creditable.data?.lines ?? [];

  /// Only lines with something actually being credited go to the server.
  const items = useMemo(
    () =>
      lines
        .filter((line) => Number(quantities[line.invoiceItemId] ?? 0) > 0)
        .map((line) => ({
          invoiceItemId: line.invoiceItemId,
          quantity: quantities[line.invoiceItemId]!,
        })),
    [lines, quantities],
  );

  const previewBody =
    invoice && items.length > 0
      ? {
          noteType: 'CREDIT_NOTE' as const,
          againstSalesInvoiceId: invoice.id,
          reason,
          ...(reasonNote.trim() ? { reasonNote: reasonNote.trim() } : {}),
          items,
        }
      : null;

  const preview = useQuery({
    queryKey: ['note-preview', previewBody],
    queryFn: () => api.post<NotePreviewResponse>('/api/notes/preview', previewBody),
    enabled: Boolean(previewBody),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  // Same trap as the other screens: placeholderData outlives the query being
  // disabled, so it is gated on there being something to price.
  const priced = previewBody ? preview.data : undefined;

  const create = useMutation({
    mutationFn: () => api.post('/api/notes', { ...previewBody, issue: true }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      // A note moves stock, the customer's ledger and the invoice's paid state.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
      onClose();
    },
  });

  const chosenReason = reasonOption(reason);
  const ready = Boolean(previewBody) && !preview.isError && !create.isPending;

  function setQuantity(line: (typeof lines)[number], raw: string) {
    if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return;
    // Cap at the server's ceiling as it is typed — a figure that would be
    // rejected should never be enterable in the first place.
    const ceiling = Number(line.creditableQuantity);
    const capped = raw !== '' && Number(raw) > ceiling ? String(ceiling) : raw;
    setQuantities((current) => ({ ...current, [line.invoiceItemId]: capped }));
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title="New credit note"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}>
            Issue credit note
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={create.error ?? preview.error} />

        {/* ---- Which invoice ---- */}
        {invoice ? (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
            <div className="min-w-0">
              <p className="text-xs text-slate-500">Against</p>
              <p className="font-medium text-slate-900 dark:text-slate-100">
                <span className="font-mono">{invoice.invoiceNumber}</span> ·{' '}
                {invoice.partyName}
              </p>
              <p className="text-xs text-slate-500">
                {formatDate(invoice.invoiceDate)} · {formatMoney(invoice.grandTotal)}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setInvoice(null);
                setQuantities({});
              }}
            >
              Change
            </Button>
          </div>
        ) : (
          <Combobox<SalesInvoiceListItem>
            ref={invoiceBox}
            label="Which invoice?"
            placeholder="Invoice number or customer name…"
            autoFocus
            items={invoices.data?.invoices ?? []}
            loading={invoices.isFetching}
            pending={invoicePending || invoices.isFetching}
            itemKey={(i) => i.id}
            itemLabel={(i) => i.invoiceNumber ?? ''}
            onSearch={setInvoiceQuery}
            onSelect={setInvoice}
            hint="Only issued invoices can be credited"
            renderItem={(i) => (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                    {i.partyName}
                  </p>
                  <p className="font-mono text-xs text-slate-500">
                    {i.invoiceNumber} · {formatDate(i.invoiceDate)}
                  </p>
                </div>
                <span className="tabular shrink-0 text-xs text-slate-500">
                  {formatMoney(i.grandTotal)}
                </span>
              </div>
            )}
          />
        )}

        {/* ---- Why ---- */}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            What happened?
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CREDIT_NOTE_REASONS.map((option) => (
              <label
                key={option.id}
                className={[
                  'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition',
                  reason === option.id
                    ? 'border-slate-900 bg-slate-50 dark:border-slate-100 dark:bg-slate-800'
                    : 'border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/50',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="reason"
                  checked={reason === option.id}
                  onChange={() => setReason(option.id)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                    {option.label}
                    {option.movesStock ? (
                      <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-normal text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                        stock returns
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-slate-500">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label="Note"
          value={reasonNote}
          onChange={(e) => setReasonNote(e.target.value)}
          hint="Optional — prints on the credit note and goes on the audit trail"
        />

        {/* ---- Lines ---- */}
        {invoice ? (
          creditable.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5 text-slate-400" />
            </div>
          ) : creditable.error ? (
            <ErrorAlert error={creditable.error} />
          ) : lines.length === 0 ? (
            <Alert tone="warning">
              Nothing left to credit on this invoice — every line has already been credited in
              full.
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 text-right font-medium">Billed</th>
                    <th className="px-2 py-2 text-right font-medium">Can credit</th>
                    <th className="px-2 py-2 text-right font-medium">Crediting</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map((line) => {
                    const exhausted = Number(line.creditableQuantity) <= 0;
                    return (
                      <tr key={line.invoiceItemId} className={exhausted ? 'opacity-50' : ''}>
                        <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
                          {line.productName}
                          <span className="block text-xs text-slate-500">per {line.unitName}</span>
                        </td>
                        <td className="tabular px-2 py-2 text-right text-slate-600 dark:text-slate-400">
                          {formatQuantity(line.invoicedQuantity)}
                        </td>
                        <td className="tabular px-2 py-2 text-right">
                          <span
                            className={
                              exhausted
                                ? 'text-slate-400'
                                : 'text-slate-900 dark:text-slate-100'
                            }
                          >
                            {formatQuantity(line.creditableQuantity)}
                          </span>
                          {Number(line.alreadyCredited) > 0 ? (
                            <span className="block text-xs text-amber-600 dark:text-amber-400">
                              {formatQuantity(line.alreadyCredited)} already
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Quantity to credit for ${line.productName}`}
                            disabled={exhausted}
                            value={quantities[line.invoiceItemId] ?? ''}
                            placeholder="0"
                            onChange={(event) => setQuantity(line, event.target.value)}
                            onFocus={(event) => event.target.select()}
                            className="tabular w-20 rounded-md border border-slate-300 px-2 py-1.5 text-right outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700 dark:disabled:bg-slate-800"
                          />
                        </td>
                        <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-400">
                          {formatMoney(line.rate)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {/* ---- What the server computed ---- */}
        {priced ? (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <Row label="Taxable value" value={priced.totals.taxableValue} />
            {priced.supplyType === 'INTER_STATE' ? (
              <Row label="IGST" value={priced.totals.totalIgst} />
            ) : (
              <>
                <Row label="CGST" value={priced.totals.totalCgst} />
                <Row label="SGST" value={priced.totals.totalSgst} />
              </>
            )}
            <div className="flex justify-between border-t border-slate-200 pt-2 dark:border-slate-800">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Credit to {priced.party.displayName}
              </span>
              <span className="tabular text-lg font-semibold text-slate-900 dark:text-slate-100">
                {formatMoney(priced.totals.grandTotal)}
              </span>
            </div>

            <p className="text-xs text-slate-500">
              {priced.affectsStock
                ? 'Goods go back on the shelf, and the tax is reversed at the rate on the original invoice.'
                : 'No stock moves — this credits money only. Tax is reversed at the rate on the original invoice.'}
            </p>

            {/* The reason and the server disagreeing would mean stock moving
                the wrong way, which is worth catching before it is written. */}
            {chosenReason && chosenReason.movesStock !== priced.affectsStock ? (
              <Alert tone="warning">
                Heads up: this reason normally{' '}
                {chosenReason.movesStock ? 'returns stock' : 'moves money only'}, but the server
                has decided otherwise. Check the reason before issuing.
              </Alert>
            ) : null}
          </div>
        ) : invoice && lines.length > 0 ? (
          <p className="text-center text-sm text-slate-500">
            Enter how much of each line is being credited.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <span className="tabular text-slate-900 dark:text-slate-100">{formatMoney(value)}</span>
    </div>
  );
}
