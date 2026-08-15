import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { prepareImage, type PreparedImage } from '../../lib/image';
import { formatDate, formatMoney } from '../../lib/money';
import type { ScannedBill } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';

/**
 * Photograph a supplier's bill, check what was read, then enter it.
 *
 * The whole design rests on one thing: **nothing here is saved**. This produces
 * a draft that lands in the ordinary purchase form, which recomputes every tax
 * and cost figure server-side from whatever the operator confirms. The model
 * shortens the typing; it does not get a vote on the numbers.
 *
 * So the screen is built to be checked rather than trusted. Anything the server
 * was unsure about is called out, the photo stays on screen beside the reading,
 * and the button says "Use this" rather than "Save".
 */
export function ScanBillDialog({
  onClose,
  onScanned,
}: {
  onClose: () => void;
  /// Hands the confirmed draft to the purchase form.
  onScanned: (bill: ScannedBill) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [prepError, setPrepError] = useState<string | null>(null);

  const scan = useMutation({
    mutationFn: () =>
      api.post<{ bill: ScannedBill }>('/api/ai/scan-purchase', {
        images: images.map(({ data, mediaType }) => ({ data, mediaType })),
      }),
  });

  const bill = scan.data?.bill;

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setPrepError(null);
    scan.reset();

    try {
      const prepared = await Promise.all(Array.from(files).slice(0, 4).map(prepareImage));
      setImages(prepared);
    } catch {
      setPrepError('Could not read that file. Use a photo or a screenshot of the bill.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title="Read a bill from a photo"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {bill ? (
            <Button onClick={() => onScanned(bill)}>Use this</Button>
          ) : (
            <Button
              onClick={() => scan.mutate()}
              loading={scan.isPending}
              disabled={images.length === 0}
            >
              Read the bill
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {prepError ? <Alert tone="error">{prepError}</Alert> : null}
        <ErrorAlert error={scan.error} />

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            // On a phone this opens the camera directly, which is the whole
            // point — the bill is in the operator's other hand.
            capture="environment"
            multiple
            onChange={(event) => void onPick(event.target.files)}
            className="hidden"
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            {images.length === 0 ? 'Take or choose a photo' : 'Choose different photos'}
          </Button>
          {images.length > 0 ? (
            <span className="text-sm text-slate-500">
              {images.length} page{images.length === 1 ? '' : 's'} ·{' '}
              {Math.round(images.reduce((total, image) => total + image.bytes, 0) / 1024)} KB
            </span>
          ) : null}
        </div>

        {images.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto">
            {images.map((image) => (
              <img
                key={image.previewUrl}
                src={image.previewUrl}
                alt="The bill being read"
                className="h-40 rounded-lg border border-slate-200 object-contain dark:border-slate-800"
              />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700">
            Photograph the whole bill, straight on and in good light. Several pages are fine.
          </p>
        )}

        {scan.isPending ? (
          <div className="flex items-center justify-center gap-3 py-8 text-sm text-slate-500">
            <Spinner className="h-5 w-5 text-slate-400" />
            Reading the bill…
          </div>
        ) : null}

        {bill ? <Reading bill={bill} /> : null}
      </div>
    </Dialog>
  );
}

function Reading({ bill }: { bill: ScannedBill }) {
  return (
    <div className="space-y-4">
      <Alert tone="info" title="Check this against the paper">
        Nothing has been saved. This fills in the purchase form, which works out the tax and the
        landed cost itself — so what matters is that the quantities and rates below match the bill
        in your hand.
      </Alert>

      {bill.warnings.map((warning) => (
        <Alert key={warning.code} tone="warning">
          {warning.message}
        </Alert>
      ))}

      {bill.notes ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          <span className="font-medium">Noted while reading:</span> {bill.notes}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Supplier"
          value={bill.supplier.match?.displayName ?? bill.supplier.nameOnBill ?? '—'}
          hint={
            bill.supplier.match
              ? bill.supplier.match.confident
                ? 'Matched'
                : `Only a guess (${Math.round(bill.supplier.match.score * 100)}%)`
              : 'Not on file — pick one in the form'
          }
          tone={bill.supplier.match?.confident ? 'good' : 'warn'}
        />
        <Field label="Bill number" value={bill.invoiceNumber ?? '—'} />
        <Field
          label="Bill date"
          value={bill.invoiceDate ? formatDate(bill.invoiceDate) : '—'}
          hint={bill.invoiceDate ? undefined : 'Could not be read — set it yourself'}
          tone={bill.invoiceDate ? 'plain' : 'warn'}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                <th className="px-4 py-2.5 font-medium">On the bill</th>
                <th className="px-3 py-2.5 font-medium">Matched to</th>
                <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                <th className="px-4 py-2.5 text-right font-medium">Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {bill.lines.map((line, index) => (
                <tr key={index}>
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                    {line.description || <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {line.match ? (
                      <span
                        className={
                          line.match.confident
                            ? 'text-slate-900 dark:text-slate-100'
                            : 'text-amber-700 dark:text-amber-400'
                        }
                      >
                        {line.match.name}
                        {line.match.confident ? null : ' (check)'}
                      </span>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400">Pick a product</span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">
                    {line.quantity ?? <span className="text-rose-600">—</span>}
                    {line.unit ? <span className="text-slate-400"> {line.unit}</span> : null}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">
                    {line.rate ?? <span className="text-rose-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bill.invoiceTotal ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          The bill states a total of{' '}
          <span className="tabular font-medium">{formatMoney(bill.invoiceTotal)}</span>. The form
          will work out its own total from the lines — if the two differ, something was misread.
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'warn';
}) {
  const toneClass = {
    plain: 'text-slate-900 dark:text-slate-100',
    good: 'text-emerald-700 dark:text-emerald-400',
    warn: 'text-amber-700 dark:text-amber-400',
  }[tone];

  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`font-medium ${toneClass}`}>{value}</p>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
