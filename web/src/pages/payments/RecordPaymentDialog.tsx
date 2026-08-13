import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatMoney, isPositiveAmount, todayInput } from '../../lib/money';
import type { PartyListItem, PartyListResponse, PaymentMode } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Combobox, type ComboboxHandle } from '../../components/Combobox';

/**
 * Taking money in.
 *
 * Deliberately does **not** ask which bills to settle. The server applies the
 * money oldest-bill-first, which is both what a shop actually does and what
 * keeps the ageing report honest; anything left over sits on the customer's
 * account. Hand-picking bills is possible through the API and belongs on the
 * payment's own screen, not in the two-second interaction at a counter.
 */

const MODES: { id: PaymentMode; label: string }[] = [
  { id: 'CASH', label: 'Cash' },
  { id: 'UPI', label: 'UPI' },
  { id: 'CHEQUE', label: 'Cheque' },
  { id: 'BANK_TRANSFER', label: 'Bank transfer' },
  { id: 'NEFT_RTGS', label: 'NEFT / RTGS' },
];

export function RecordPaymentDialog({
  presetPartyId,
  presetPartyName,
  onClose,
}: {
  presetPartyId?: string;
  presetPartyName?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [partyId, setPartyId] = useState(presetPartyId ?? '');
  const [partyName, setPartyName] = useState(presetPartyName ?? '');
  const [partyQuery, setPartyQuery] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [paymentDate, setPaymentDate] = useState(todayInput());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  // Cheque details, required by the server when mode is CHEQUE.
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDate, setChequeDate] = useState(todayInput());

  const partyBox = useRef<ComboboxHandle>(null);
  const debouncedParty = useDebounced(partyQuery);
  const partyPending = partyQuery.trim() !== debouncedParty.trim();

  const parties = useQuery({
    queryKey: ['parties', 'search', debouncedParty],
    queryFn: () =>
      api.get<PartyListResponse>('/api/masters/parties', {
        query: { search: debouncedParty, pageSize: 8, isActive: true },
      }),
    enabled: !presetPartyId && debouncedParty.trim().length > 0,
  });

  const record = useMutation({
    mutationFn: () =>
      api.post('/api/payments', {
        partyId,
        direction: 'RECEIPT',
        amount,
        mode,
        paymentDate,
        ...(reference.trim() ? { referenceNumber: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(mode === 'CHEQUE'
          ? {
              cheque: {
                chequeNumber: chequeNumber.trim(),
                bankName: chequeBank.trim(),
                chequeDate,
              },
            }
          : {}),
      }),
    onSuccess() {
      // The bills this settled, the ledger, and the ageing report have moved.
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['cheques'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      onClose();
    },
  });

  const fieldErrors = record.error instanceof ApiError ? record.error.fieldErrors : {};

  const chequeReady =
    mode !== 'CHEQUE' || (chequeNumber.trim().length > 0 && chequeBank.trim().length >= 2);

  const ready = Boolean(partyId) && isPositiveAmount(amount) && chequeReady && !record.isPending;

  /// A cheque dated in the future cannot be banked yet — worth saying so before
  /// it is recorded, since the money is not really in hand.
  const postDated = useMemo(
    () => mode === 'CHEQUE' && chequeDate > todayInput(),
    [mode, chequeDate],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) record.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={record.isPending} disabled={!ready}>
            Record {isPositiveAmount(amount) ? formatMoney(amount) : ''}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={record.error} />

        {presetPartyId ? (
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
            <p className="text-xs text-slate-500">From</p>
            <p className="font-medium text-slate-900 dark:text-slate-100">{partyName}</p>
          </div>
        ) : (
          <Combobox<PartyListItem>
            ref={partyBox}
            label="From"
            placeholder="Customer name or phone…"
            autoFocus
            items={parties.data?.parties ?? []}
            loading={parties.isFetching}
            pending={partyPending || parties.isFetching}
            itemKey={(p) => p.id}
            itemLabel={(p) => p.displayName}
            onSearch={setPartyQuery}
            onSelect={(p) => {
              setPartyId(p.id);
              setPartyName(p.displayName);
            }}
            renderItem={(p) => (
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{p.displayName}</span>
                {Number(p.currentBalance) > 0 ? (
                  <span className="tabular shrink-0 text-xs text-amber-600 dark:text-amber-400">
                    {formatMoney(p.currentBalance)} due
                  </span>
                ) : null}
              </div>
            )}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Amount"
            value={amount}
            onChange={(e) => {
              const next = e.target.value;
              if (next === '' || /^\d*\.?\d*$/.test(next)) setAmount(next);
            }}
            error={fieldErrors['amount']}
            inputMode="decimal"
            required
            autoFocus={Boolean(presetPartyId)}
            placeholder="0.00"
            className="tabular"
          />
          <Field
            label="Date"
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            error={fieldErrors['paymentDate']}
            required
          />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            How
          </legend>
          <div className="flex flex-wrap gap-2">
            {MODES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                aria-pressed={mode === id}
                className={[
                  'rounded-lg border px-3 py-2 text-sm font-medium transition',
                  mode === id
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {mode === 'CHEQUE' ? (
          <div className="space-y-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Cheque number"
                value={chequeNumber}
                onChange={(e) => setChequeNumber(e.target.value)}
                error={fieldErrors['cheque.chequeNumber']}
                required
                className="font-mono"
                placeholder="004521"
              />
              <Field
                label="Bank"
                value={chequeBank}
                onChange={(e) => setChequeBank(e.target.value)}
                error={fieldErrors['cheque.bankName']}
                required
                placeholder="Punjab National Bank"
              />
            </div>
            <Field
              label="Date on the cheque"
              type="date"
              value={chequeDate}
              onChange={(e) => setChequeDate(e.target.value)}
              error={fieldErrors['cheque.chequeDate']}
              hint="Often weeks ahead — that is why cheques are tracked separately"
              required
            />
            {postDated ? (
              <Alert tone="info">
                Post-dated. It will be recorded against the bill now, and shown as bankable once
                that date arrives. If it later bounces, the bill reopens.
              </Alert>
            ) : null}
          </div>
        ) : (
          <Field
            label={mode === 'UPI' ? 'UPI reference' : 'Reference'}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            error={fieldErrors['referenceNumber']}
            hint="Optional — transaction ID, slip number"
          />
        )}

        <Field
          label="Note"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          hint="Optional"
        />

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">
          Applied to the oldest unpaid bills first. Anything left over stays on the customer's
          account for the next bill.
        </p>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
