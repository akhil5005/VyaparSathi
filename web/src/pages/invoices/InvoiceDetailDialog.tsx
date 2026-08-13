import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, requestBlob } from '../../lib/api';
import { formatDate, formatMoney, formatPercent, formatQuantity } from '../../lib/money';
import type { SalesInvoiceDetail } from '../../lib/types';
import { CAN_EDIT_MASTERS, CAN_SEE_COST, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { CancelInvoiceDialog } from './CancelInvoiceDialog';

/**
 * One invoice, as issued.
 *
 * Read-only by design. An issued invoice carries a number that has been given
 * to a customer and reported to the government; editing it would silently
 * rewrite history. The only destructive action offered is cancellation, which
 * reverses the stock and ledger with contra entries and **keeps the number
 * spent** — a gap in the series is a compliance problem, so the number is never
 * reused.
 */
export function InvoiceDetailDialog({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const canCancel = can(...CAN_EDIT_MASTERS);
  const canSeeCost = can(...CAN_SEE_COST);

  const [cancelling, setCancelling] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const invoice = useQuery({
    queryKey: ['invoices', invoiceId],
    queryFn: () => api.get<{ invoice: SalesInvoiceDetail }>(`/api/sales-invoices/${invoiceId}`),
  });

  const inv = invoice.data?.invoice;

  async function reprint(download: boolean) {
    setPrinting(true);
    setPrintError(null);
    try {
      // Blob rather than window.open: the endpoint needs the bearer token and
      // a plain navigation cannot carry one.
      const { blob, filename } = await requestBlob(
        `/api/printing/invoices/${invoiceId}/pdf`,
        { query: { copy: 'ORIGINAL', download: download ? 'true' : 'false' } },
      );
      const url = URL.createObjectURL(blob);

      if (download) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } else {
        window.open(url, '_blank');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setPrintError('Could not produce the PDF. Try again in a moment.');
    } finally {
      setPrinting(false);
    }
  }

  const intraState = inv?.supplyType === 'INTRA_STATE';

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="wide"
        title={inv?.invoiceNumber ?? 'Invoice'}
        footer={
          <>
            {canCancel && inv?.status === 'ISSUED' ? (
              <Button variant="danger" onClick={() => setCancelling(true)}>
                Cancel invoice
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void reprint(true)} loading={printing}>
              Download
            </Button>
            <Button variant="secondary" onClick={() => void reprint(false)} loading={printing}>
              Print
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        {invoice.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-6 w-6 text-slate-400" />
          </div>
        ) : invoice.error ? (
          <ErrorAlert error={invoice.error} />
        ) : inv ? (
          <div className="space-y-4">
            {inv.status === 'CANCELLED' ? (
              <Alert tone="error" title="Cancelled">
                {inv.cancelledReason}
                {inv.cancelledAt ? ` — ${formatDate(inv.cancelledAt)}` : ''}. The stock and ledger
                were reversed; the invoice number stays spent.
              </Alert>
            ) : null}

            {printError ? <Alert tone="warning">{printError}</Alert> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Block label="Billed to">
                <p className="font-medium text-slate-900 dark:text-slate-100">{inv.partyName}</p>
                <p className="font-mono text-xs text-slate-500">
                  {inv.partyGstin ?? 'Unregistered'}
                </p>
                {inv.partyAddress ? (
                  <p className="text-xs text-slate-500">{inv.partyAddress}</p>
                ) : null}
              </Block>

              <Block label="Invoice">
                <dl className="space-y-0.5 text-xs">
                  <Meta term="Date" value={formatDate(inv.invoiceDate)} />
                  {inv.dueDate ? <Meta term="Due" value={formatDate(inv.dueDate)} /> : null}
                  <Meta
                    term="Supply"
                    value={intraState ? 'Within Punjab (CGST + SGST)' : 'Interstate (IGST)'}
                  />
                  <Meta term="Printed" value={`${inv.printedCount} time${inv.printedCount === 1 ? '' : 's'}`} />
                </dl>
              </Block>
            </div>

            {/* ---- Lines ---- */}
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 text-right font-medium">Qty</th>
                    <th className="px-2 py-2 text-right font-medium">Rate</th>
                    <th className="px-2 py-2 text-right font-medium">Taxable</th>
                    <th className="px-2 py-2 text-right font-medium">
                      {intraState ? 'CGST+SGST' : 'IGST'}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {inv.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2">
                        <p className="text-slate-900 dark:text-slate-100">{item.productName}</p>
                        <p className="text-xs text-slate-500">HSN {item.hsnCode}</p>
                      </td>
                      <td className="tabular px-2 py-2 text-right text-slate-700 dark:text-slate-300">
                        {formatQuantity(item.quantity)} {item.unitName}
                      </td>
                      <td className="tabular px-2 py-2 text-right text-slate-700 dark:text-slate-300">
                        {formatMoney(item.rate)}
                      </td>
                      <td className="tabular px-2 py-2 text-right text-slate-700 dark:text-slate-300">
                        {formatMoney(item.taxableValue)}
                      </td>
                      <td className="tabular px-2 py-2 text-right text-slate-500">
                        {intraState
                          ? `${formatMoney(String(Number(item.cgstAmount) + Number(item.sgstAmount)))} (${formatPercent(String(Number(item.cgstRate) + Number(item.sgstRate)))})`
                          : `${formatMoney(item.igstAmount)} (${formatPercent(item.igstRate)})`}
                      </td>
                      <td className="tabular px-3 py-2 text-right font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- Totals ---- */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                {inv.amountInWords ? (
                  <Block label="Amount in words">
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                      {inv.amountInWords}
                    </p>
                  </Block>
                ) : null}

                {inv.allocations.length > 0 ? (
                  <Block label="Payments applied">
                    <ul className="space-y-0.5 text-xs">
                      {inv.allocations.map((allocation) => (
                        <li key={allocation.id} className="flex justify-between gap-3">
                          <span className="font-mono text-slate-500">
                            {allocation.payment?.voucherNumber ?? '—'}
                            {allocation.payment
                              ? ` · ${formatDate(allocation.payment.paymentDate)}`
                              : ''}
                          </span>
                          <span className="tabular text-slate-700 dark:text-slate-300">
                            {formatMoney(allocation.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Block>
                ) : null}

                {canSeeCost && inv.costOfGoods ? (
                  <Block label="Margin">
                    <p className="tabular text-sm text-slate-700 dark:text-slate-300">
                      Cost {formatMoney(inv.costOfGoods)} · Margin{' '}
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {formatMoney(
                          String(Number(inv.taxableValue) - Number(inv.costOfGoods)),
                        )}
                      </span>
                    </p>
                  </Block>
                ) : null}
              </div>

              <dl className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                <Row label="Taxable value" value={inv.taxableValue} />
                {intraState ? (
                  <>
                    <Row label="CGST" value={inv.totalCgst} />
                    <Row label="SGST" value={inv.totalSgst} />
                  </>
                ) : (
                  <Row label="IGST" value={inv.totalIgst} />
                )}
                {Number(inv.freightCharges) > 0 ? (
                  <Row label="Freight" value={inv.freightCharges} />
                ) : null}
                {Number(inv.roundOff) !== 0 ? <Row label="Round off" value={inv.roundOff} /> : null}

                <div className="flex justify-between border-t border-slate-200 pt-2 dark:border-slate-800">
                  <dt className="font-semibold text-slate-900 dark:text-slate-100">Total</dt>
                  <dd className="tabular text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {formatMoney(inv.grandTotal)}
                  </dd>
                </div>

                <Row label="Paid" value={inv.amountPaid} />
                <div className="flex justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Still due</dt>
                  <dd
                    className={[
                      'tabular font-medium',
                      Number(inv.amountDue) > 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                    ].join(' ')}
                  >
                    {formatMoney(inv.amountDue)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        ) : null}
      </Dialog>

      {cancelling && inv ? (
        <CancelInvoiceDialog
          invoice={inv}
          onClose={() => setCancelling(false)}
          onDone={() => {
            setCancelling(false);
            void invoice.refetch();
          }}
        />
      ) : null}
    </>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">{label}</p>
      {children}
    </div>
  );
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{term}</dt>
      <dd className="text-slate-700 dark:text-slate-300">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="tabular text-slate-900 dark:text-slate-100">{formatMoney(value)}</dd>
    </div>
  );
}
