import { useEffect, useState } from 'react';
import { requestBlob } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import type { CreateInvoiceResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/Alert';

/**
 * Shown the moment a bill is issued.
 *
 * The invoice number exists now and can never be reused, so this confirms it
 * plainly and gets the paper into the customer's hand. Printing happens
 * immediately and automatically — at a counter, the operator has already moved
 * on to the next customer.
 */
export function IssuedInvoiceDialog({
  result,
  onClose,
}: {
  result: CreateInvoiceResponse;
  onClose: () => void;
}) {
  const { invoice } = result;
  const [printError, setPrintError] = useState<string | null>(null);
  /// A softer note than an error — the bill is saved either way.
  const [printHint, setPrintHint] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  async function openPdf(download: boolean) {
    setPrinting(true);
    setPrintError(null);
    try {
      /**
       * Fetched as a blob rather than pointed at with `window.open`.
       *
       * The PDF endpoint needs the bearer token, and a plain navigation cannot
       * carry an Authorization header — it would arrive unauthenticated and
       * 401. Fetching it here and handing the browser an object URL keeps the
       * request authenticated and works identically across origins.
       */
      const { blob, filename } = await requestBlob(
        `/api/printing/invoices/${invoice.id}/pdf`,
        { query: { copy: 'ORIGINAL', download: download ? 'true' : 'false' } },
      );

      const url = URL.createObjectURL(blob);

      if (download) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } else {
        const printWindow = window.open(url, '_blank');
        if (!printWindow) {
          // A null return usually means pop-ups are blocked — but not always.
          // Chrome returns null for a blob: tab it nonetheless opens, so
          // asserting "blocked" produced an alarming message sitting next to a
          // PDF that had opened perfectly well. Hedged, and demoted to a hint.
          setPrintHint(
            "If the invoice didn't open in a new tab, your browser blocked it — use Download PDF.",
          );
        }
      }

      // Revoked on a delay: released immediately, the new tab never loads it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setPrintError('Could not produce the PDF. The bill is saved — try printing from Invoices.');
    } finally {
      setPrinting(false);
    }
  }

  // Print without being asked. The bill is saved either way, so a failure here
  // is an inconvenience rather than a lost sale.
  useEffect(() => {
    void openPdf(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Bill saved"
      footer={
        <>
          <Button variant="secondary" onClick={() => void openPdf(true)} loading={printing}>
            Download PDF
          </Button>
          <Button variant="secondary" onClick={() => void openPdf(false)} loading={printing}>
            Print again
          </Button>
          <Button onClick={onClose} autoFocus>
            Next customer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-4 text-center dark:bg-slate-800/60">
          <p className="font-mono text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {invoice.invoiceNumber}
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{invoice.partyName}</p>
          <p className="tabular mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-100">
            {formatMoney(invoice.grandTotal)}
          </p>
        </div>

        {result.warnings?.length ? (
          <Alert tone="warning" title="Worth checking">
            <ul className="list-inside list-disc space-y-0.5">
              {result.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {printError ? <Alert tone="warning">{printError}</Alert> : null}
        {printHint ? <Alert tone="info">{printHint}</Alert> : null}

        <p className="text-center text-xs text-slate-500">
          Stock and the customer's ledger have been updated. Record a payment from the Payments
          screen when the money comes in.
        </p>
      </div>
    </Dialog>
  );
}
