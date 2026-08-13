import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatQuantity, todayInput } from '../../lib/money';
import type { ProductDetail } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Correcting the stock figure.
 *
 * The API takes a **signed delta**, not a new total — which is right for the
 * ledger but wrong for the person standing at the shelf, who has just counted
 * 43 and does not want to work out that 43 − 45 is −2. So this asks for the
 * counted figure and computes the difference, showing it before anything is
 * sent.
 *
 * A reason is mandatory: an adjustment is the one stock movement with no
 * document behind it, so the note is the only record of why the number
 * changed.
 */
export function AdjustStockDialog({
  product,
  onClose,
  onDone,
}: {
  product: ProductDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const onHand = Number(product.quantityOnHand);

  const [mode, setMode] = useState<'count' | 'delta'>('count');
  const [counted, setCounted] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  const change =
    mode === 'count'
      ? counted === ''
        ? null
        : Number(counted) - onHand
      : delta === ''
        ? null
        : Number(delta);

  const adjust = useMutation({
    mutationFn: () =>
      api.post(`/api/masters/products/${product.id}/adjust-stock`, {
        quantity: String(change),
        reason: reason.trim(),
        asOfDate: todayInput(),
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onDone();
    },
  });

  const fieldErrors = adjust.error instanceof ApiError ? adjust.error.fieldErrors : {};

  const ready =
    change !== null &&
    Number.isFinite(change) &&
    change !== 0 &&
    reason.trim().length >= 3 &&
    !adjust.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) adjust.mutate();
  }

  const unit = product.baseUnit?.symbol ?? '';

  return (
    <Dialog
      open
      onClose={onClose}
      title="Adjust stock"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={adjust.isPending} disabled={!ready}>
            Adjust
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={adjust.error} />

        <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
          <p className="text-xs text-slate-500">{product.name} — currently</p>
          <p className="tabular text-lg font-semibold text-slate-900 dark:text-slate-100">
            {formatQuantity(product.quantityOnHand)} {unit}
          </p>
        </div>

        <div className="flex gap-2">
          <ModeButton active={mode === 'count'} onClick={() => setMode('count')}>
            I counted the shelf
          </ModeButton>
          <ModeButton active={mode === 'delta'} onClick={() => setMode('delta')}>
            Add or remove
          </ModeButton>
        </div>

        {mode === 'count' ? (
          <Field
            label="Counted quantity"
            value={counted}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setCounted(v);
            }}
            inputMode="decimal"
            hint={`What is actually on the shelf, in ${unit}`}
            className="tabular"
            required
            autoFocus
            placeholder={formatQuantity(product.quantityOnHand)}
          />
        ) : (
          <Field
            label="Change"
            value={delta}
            onChange={(e) => {
              const v = e.target.value;
              // A leading minus is the whole point of this mode.
              if (v === '' || v === '-' || /^-?\d*\.?\d*$/.test(v)) setDelta(v);
            }}
            inputMode="decimal"
            hint="Negative to remove, e.g. -2 for two damaged"
            className="tabular"
            required
            autoFocus
            placeholder="-2"
          />
        )}

        {change !== null && Number.isFinite(change) && change !== 0 ? (
          <Alert tone={change > 0 ? 'info' : 'warning'}>
            {change > 0 ? 'Adding' : 'Removing'}{' '}
            <strong>
              {formatQuantity(String(Math.abs(change)))} {unit}
            </strong>{' '}
            — new balance will be{' '}
            <strong>
              {formatQuantity(String(onHand + change))} {unit}
            </strong>
            .
          </Alert>
        ) : change === 0 && (counted !== '' || delta !== '') ? (
          <Alert tone="info">That matches the current figure — nothing to adjust.</Alert>
        ) : null}

        <Field
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={fieldErrors['reason']}
          hint="Goes on the audit trail — this is the only record of why"
          required
          placeholder="Damaged in transit / stock count correction"
        />

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition',
        active
          ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
          : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
