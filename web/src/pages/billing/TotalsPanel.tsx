import { formatMoney } from '../../lib/money';
import type { PreviewResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';

/**
 * The totals, straight from the server.
 *
 * Every figure here was computed by the same code that will produce the issued
 * invoice — nothing on this panel is calculated in the browser. The CGST/SGST
 * versus IGST split is likewise the server's decision, derived from the two
 * GSTINs' state codes, so the panel just renders whichever it was told.
 */
export function TotalsPanel({
  preview,
  loading,
  error,
  freight,
  onFreightChange,
  notes,
  onNotesChange,
  onIssue,
  issuing,
  canIssue,
}: {
  preview: PreviewResponse | undefined;
  loading: boolean;
  error: unknown;
  freight: string;
  onFreightChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  onIssue: () => void;
  issuing: boolean;
  canIssue: boolean;
}) {
  const totals = preview?.totals;
  const interState = preview?.supplyType === 'INTER_STATE';

  return (
    <aside className="lg:sticky lg:top-20 lg:h-fit">
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">Bill total</h2>
          {loading ? <Spinner className="h-4 w-4 text-slate-400" /> : null}
        </div>

        <ErrorAlert error={error} />

        <dl className="space-y-1.5 text-sm">
          <Row label="Taxable value" value={totals?.taxableValue} />

          {Number(totals?.totalDiscount ?? 0) > 0 ? (
            <Row label="Discount" value={totals?.totalDiscount} />
          ) : null}

          {interState ? (
            <Row label="IGST" value={totals?.totalIgst} />
          ) : (
            <>
              <Row label="CGST" value={totals?.totalCgst} />
              <Row label="SGST" value={totals?.totalSgst} />
            </>
          )}

          {Number(totals?.totalCess ?? 0) > 0 ? (
            <Row label="Cess" value={totals?.totalCess} />
          ) : null}
          {Number(totals?.freightCharges ?? 0) > 0 ? (
            <Row label="Freight" value={totals?.freightCharges} />
          ) : null}
          {Number(totals?.roundOff ?? 0) !== 0 ? (
            <Row label="Round off" value={totals?.roundOff} />
          ) : null}
        </dl>

        <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-slate-900 dark:text-slate-100">Total</span>
            <span className="tabular text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {totals ? formatMoney(totals.grandTotal) : '—'}
            </span>
          </div>
          {preview?.amountInWords ? (
            <p className="mt-1 text-xs text-slate-500">{preview.amountInWords}</p>
          ) : null}
          {preview ? (
            <p className="mt-2 text-xs text-slate-400">
              {interState ? 'Inter-state supply — IGST' : 'Within Punjab — CGST + SGST'}
            </p>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
              Freight / delivery
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={freight}
              placeholder="0"
              onChange={(event) => {
                const next = event.target.value;
                if (next === '' || /^\d*\.?\d*$/.test(next)) onFreightChange(next);
              }}
              className="tabular w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-right outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
            />
            {/* Freight is added after tax as a reimbursement. If it should be
                taxed, it belongs on a line against the transport HSN. */}
            <span className="mt-1 block text-xs text-slate-400">Added after tax</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-600 dark:text-slate-400">Note</span>
            <textarea
              rows={2}
              value={notes}
              onChange={(event) => onNotesChange(event.target.value)}
              placeholder="Optional — prints on the invoice"
              className="w-full resize-none rounded-md border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
            />
          </label>
        </div>

        <Button
          size="lg"
          className="w-full"
          onClick={onIssue}
          loading={issuing}
          disabled={!canIssue}
        >
          Save &amp; print <span className="text-xs opacity-60">F9</span>
        </Button>

        <p className="text-center text-xs text-slate-400">
          Issuing assigns the invoice number and moves stock. It cannot be deleted afterwards, only
          cancelled.
        </p>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="tabular text-slate-900 dark:text-slate-100">
        {value === undefined ? '—' : formatMoney(value)}
      </dd>
    </div>
  );
}
