import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatMoney, formatQuantity } from '../../lib/money';
import type { SalesInvoiceDetail } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Cancelling an issued invoice.
 *
 * Not a delete. The server writes contra entries that put the stock back and
 * reverse the customer's ledger, and the invoice number **stays spent** — a gap
 * in the series is a compliance problem, so it is never reused or backfilled.
 *
 * Spelling out exactly what will move matters here, because this is irreversible
 * and the person doing it is usually in a hurry. A credit note is often the
 * right instrument instead: use cancellation when the bill should never have
 * existed, and a credit note when goods came back.
 */
export function CancelInvoiceDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: SalesInvoiceDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const cancel = useMutation({
    mutationFn: () =>
      api.post(`/api/sales-invoices/${invoice.id}/cancel`, { reason: reason.trim() }),
    onSuccess() {
      // Stock, the ledger and the ageing report have all moved back.
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
      onDone();
    },
  });

  const fieldErrors = cancel.error instanceof ApiError ? cancel.error.fieldErrors : {};
  const ready = reason.trim().length >= 3 && !cancel.isPending;
  const hasPayments = invoice.allocations.length > 0;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) cancel.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancel ${invoice.invoiceNumber}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" onClick={onSubmit} loading={cancel.isPending} disabled={!ready}>
            Cancel invoice
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={cancel.error} />

        <Alert tone="warning" title="This cannot be undone">
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>
              {invoice.items.length === 1
                ? // Naming the unit matters: "10 goes back" is ambiguous
                  // between reams and kilograms, which differ by 2.3x here.
                  `${formatQuantity(invoice.items[0]!.quantity)} ${invoice.items[0]!.unitName}`
                : `${invoice.items.length} lines`}{' '}
              of stock goes back on the shelf
            </li>
            <li>
              {formatMoney(invoice.grandTotal)} comes off {invoice.partyName}'s account
            </li>
            <li>
              Invoice number <span className="font-mono">{invoice.invoiceNumber}</span> stays used —
              it is never reissued
            </li>
          </ul>
        </Alert>

        {hasPayments ? (
          <Alert tone="error">
            {formatMoney(invoice.amountPaid)} has already been received against this bill. That
            money will be left sitting on {invoice.partyName}'s account — check with them before
            cancelling.
          </Alert>
        ) : null}

        <Alert tone="info">
          If the goods came back, a <strong>credit note</strong> is usually the right instrument
          instead — it keeps the original bill intact, which is what the GST return expects.
          Cancel only when the invoice should never have existed.
        </Alert>

        <Field
          label="Why?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={fieldErrors['reason']}
          hint="Goes on the audit trail and prints on the cancelled invoice"
          required
          autoFocus
          placeholder="Billed to the wrong customer"
        />

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
