import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney, todayInput } from '../../lib/money';
import type { Cheque, ChequeStatus } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Cheques in hand, and what can be done with each.
 *
 * A cheque is not money until it clears, and in this trade it is routinely
 * written weeks ahead. The server posts it against the bill on receipt — so the
 * customer's balance reflects it immediately — and reopens the bill if it later
 * bounces. `bankable` is the server's answer to "can I take this to the bank
 * today", which is the only question actually being asked here.
 */

const STATUS_STYLE: Record<ChequeStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  DEPOSITED: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  CLEARED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  BOUNCED: 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
  CANCELLED: 'bg-slate-100 text-slate-500 line-through dark:bg-slate-800 dark:text-slate-500',
};

export function ChequeList({ cheques }: { cheques: Cheque[] }) {
  const queryClient = useQueryClient();
  const [bouncing, setBouncing] = useState<Cheque | null>(null);

  const refresh = () => {
    // Clearing or bouncing moves the ledger, so the udhaar report moves too.
    void queryClient.invalidateQueries({ queryKey: ['cheques'] });
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
    void queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'deposit' | 'clear' | 'cancel' }) =>
      api.post(`/api/payments/cheques/${id}/${action}`, {}),
    onSuccess: refresh,
  });

  if (cheques.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
        No cheques on hand.
      </p>
    );
  }

  return (
    <>
      <ErrorAlert error={act.error} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                <th className="px-4 py-2.5 font-medium">Cheque</th>
                <th className="px-3 py-2.5 font-medium">From</th>
                <th className="px-3 py-2.5 font-medium">Dated</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {cheques.map((cheque) => (
                <tr key={cheque.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3">
                    <p className="font-mono text-slate-900 dark:text-slate-100">
                      {cheque.chequeNumber}
                    </p>
                    <p className="text-xs text-slate-500">{cheque.bankName}</p>
                  </td>

                  <td className="px-3 py-3 text-slate-900 dark:text-slate-100">
                    {cheque.party?.displayName ?? '—'}
                  </td>

                  <td className="px-3 py-3">
                    <p className="text-slate-700 dark:text-slate-300">
                      {formatDate(cheque.chequeDate)}
                    </p>
                    {cheque.status === 'PENDING' ? (
                      <p
                        className={
                          cheque.bankable
                            ? 'text-xs text-emerald-600 dark:text-emerald-400'
                            : 'text-xs text-slate-400'
                        }
                      >
                        {cheque.bankable ? 'Can bank now' : 'Post-dated'}
                      </p>
                    ) : null}
                  </td>

                  <td className="tabular px-3 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                    {formatMoney(cheque.amount)}
                  </td>

                  <td className="px-3 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[cheque.status]}`}
                    >
                      {cheque.status[0] + cheque.status.slice(1).toLowerCase()}
                    </span>
                    {cheque.status === 'BOUNCED' && cheque.bounceReason ? (
                      <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-400">
                        {cheque.bounceReason}
                      </p>
                    ) : null}
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      {cheque.status === 'PENDING' ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            // Banking a post-dated cheque bounces it and costs
                            // charges, so the button is not offered early.
                            disabled={!cheque.bankable || act.isPending}
                            onClick={() => act.mutate({ id: cheque.id, action: 'deposit' })}
                          >
                            Deposit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: cheque.id, action: 'cancel' })}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : null}

                      {cheque.status === 'DEPOSITED' ? (
                        <>
                          <Button
                            size="sm"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: cheque.id, action: 'clear' })}
                          >
                            Cleared
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setBouncing(cheque)}>
                            Bounced
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bouncing ? (
        <BounceDialog
          cheque={bouncing}
          onClose={() => setBouncing(null)}
          onDone={() => {
            setBouncing(null);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Recording a bounce.
 *
 * Needs the bank's return reason for the audit trail, and optionally the
 * charges to recover — which post to the customer's ledger, because the shop
 * paid them on the customer's behalf. The bill reopens either way.
 */
function BounceDialog({
  cheque,
  onClose,
  onDone,
}: {
  cheque: Cheque;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [charges, setCharges] = useState('');

  const bounce = useMutation({
    mutationFn: () =>
      api.post(`/api/payments/cheques/${cheque.id}/bounce`, {
        reason: reason.trim(),
        ...(Number(charges) > 0 ? { bounceCharges: charges } : {}),
        bouncedOn: todayInput(),
      }),
    onSuccess: onDone,
  });

  const ready = reason.trim().length >= 3 && !bounce.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) bounce.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Cheque bounced"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onSubmit} loading={bounce.isPending} disabled={!ready}>
            Record bounce
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={bounce.error} />

        <Alert tone="warning">
          {formatMoney(cheque.amount)} from {cheque.party?.displayName} will go back onto their
          account, and the bills it settled will reopen.
        </Alert>

        <Field
          label="Bank's reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="As written on the return memo — it goes on the audit trail"
          required
          autoFocus
          placeholder="Insufficient funds"
        />

        <Field
          label="Bank charges to recover"
          value={charges}
          onChange={(e) => {
            const next = e.target.value;
            if (next === '' || /^\d*\.?\d*$/.test(next)) setCharges(next);
          }}
          inputMode="decimal"
          hint="Optional — posted to the customer's ledger"
          placeholder="0.00"
          className="tabular"
        />

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
