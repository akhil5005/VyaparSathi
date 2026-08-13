import type { KeyboardEvent, RefObject } from 'react';
import { formatMoney, formatQuantity } from '../../lib/money';
import type { PreviewLine } from '../../lib/types';
import type { DraftLine } from './useBillingDraft';

/**
 * The lines being billed.
 *
 * Editable columns hold what the operator typed; the money columns hold what
 * the server priced. They are matched up by product rather than by index,
 * because a line still being typed is not sent for pricing and so the two lists
 * can be different lengths.
 */
export function LineItemsTable({
  lines,
  pricedLines,
  onUpdate,
  onRemove,
  lastQuantityRef,
  onQuantityEnter,
}: {
  lines: DraftLine[];
  pricedLines: PreviewLine[] | undefined;
  onUpdate: (key: string, patch: Partial<DraftLine>) => void;
  onRemove: (key: string) => void;
  lastQuantityRef: RefObject<HTMLInputElement | null>;
  onQuantityEnter: () => void;
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700">
        No items yet. Search above to add the first one.
      </p>
    );
  }

  // The server prices in the order it was given, and skipped lines are always a
  // suffix of the typed list from the server's point of view — so walking a
  // cursor through the priced lines matches them up even with duplicates of the
  // same product on separate rows.
  let priceCursor = 0;
  const priceFor = (line: DraftLine): PreviewLine | undefined => {
    const billable = Number(line.quantity) > 0 && line.rate !== '';
    return billable ? pricedLines?.[priceCursor++] : undefined;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="pb-2 pr-2 font-medium">Item</th>
            <th className="pb-2 px-2 text-right font-medium">Qty</th>
            <th className="pb-2 px-2 text-right font-medium">Rate</th>
            <th className="pb-2 px-2 text-right font-medium">Disc %</th>
            <th className="pb-2 px-2 text-right font-medium">Taxable</th>
            <th className="pb-2 px-2 text-right font-medium">Tax</th>
            <th className="pb-2 pl-2 text-right font-medium">Total</th>
            <th className="pb-2 w-8" />
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((line, index) => {
            const priced = priceFor(line);
            const overStock = Number(line.quantity) > Number(line.availableStock);
            const isLast = index === lines.length - 1;

            const tax = priced
              ? Number(priced.cgstAmount) + Number(priced.sgstAmount) + Number(priced.igstAmount)
              : null;

            return (
              <tr key={line.key} className="align-top">
                <td className="py-2 pr-2">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {line.productName}
                  </p>
                  <p className="text-xs text-slate-500">
                    HSN {line.hsnCode || '—'} · per {line.unitName}
                  </p>
                  {overStock ? (
                    <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                      Only {formatQuantity(line.availableStock)} in stock
                    </p>
                  ) : null}
                </td>

                <td className="px-2 py-2">
                  <NumberCell
                    ref={isLast ? lastQuantityRef : undefined}
                    value={line.quantity}
                    onChange={(quantity) => onUpdate(line.key, { quantity })}
                    onEnter={onQuantityEnter}
                    ariaLabel={`Quantity for ${line.productName}`}
                    invalid={line.quantity !== '' && Number(line.quantity) <= 0}
                  />
                </td>

                <td className="px-2 py-2">
                  <NumberCell
                    value={line.rate}
                    onChange={(rate) => onUpdate(line.key, { rate })}
                    onEnter={onQuantityEnter}
                    ariaLabel={`Rate for ${line.productName}`}
                    invalid={line.rate !== '' && Number(line.rate) < 0}
                  />
                </td>

                <td className="px-2 py-2">
                  <NumberCell
                    value={line.discountPercent}
                    onChange={(discountPercent) => onUpdate(line.key, { discountPercent })}
                    onEnter={onQuantityEnter}
                    ariaLabel={`Discount percent for ${line.productName}`}
                    placeholder="0"
                    invalid={Number(line.discountPercent) > 100}
                  />
                </td>

                <td className="tabular px-2 py-3 text-right text-slate-700 dark:text-slate-300">
                  {priced ? formatMoney(priced.taxableValue) : <Pending />}
                </td>

                <td className="tabular px-2 py-3 text-right text-slate-500">
                  {priced ? (
                    <>
                      {formatMoney(String(tax))}
                      <span className="ml-1 text-xs">
                        (
                        {Number(priced.igstRate) > 0
                          ? `${formatQuantity(priced.igstRate)}%`
                          : `${formatQuantity(String(Number(priced.cgstRate) + Number(priced.sgstRate)))}%`}
                        )
                      </span>
                    </>
                  ) : (
                    <Pending />
                  )}
                </td>

                <td className="tabular py-3 pl-2 text-right font-medium text-slate-900 dark:text-slate-100">
                  {priced ? formatMoney(priced.lineTotal) : <Pending />}
                </td>

                <td className="py-3 pl-1 text-right">
                  <button
                    type="button"
                    onClick={() => onRemove(line.key)}
                    aria-label={`Remove ${line.productName}`}
                    className="rounded p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const Pending = () => <span className="text-slate-300 dark:text-slate-700">—</span>;

/**
 * A numeric cell that keeps the raw string.
 *
 * `type="text"` with `inputMode="decimal"`, not `type="number"`: a number input
 * silently discards intermediate states like "10." and, worse, can be changed
 * by a stray scroll wheel over a focused field. On a rate column that is a
 * mispriced invoice nobody notices.
 */
function NumberCell({
  ref,
  value,
  onChange,
  onEnter,
  ariaLabel,
  placeholder,
  invalid,
}: {
  ref?: RefObject<HTMLInputElement | null> | undefined;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  ariaLabel: string;
  placeholder?: string;
  invalid?: boolean;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      onEnter();
    }
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      value={value}
      placeholder={placeholder}
      onChange={(event) => {
        // Digits and one decimal point. Rejecting the keystroke rather than
        // correcting after the fact keeps the caret where the user put it.
        const next = event.target.value;
        if (next === '' || /^\d*\.?\d*$/.test(next)) onChange(next);
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => event.target.select()}
      className={[
        'tabular w-20 rounded-md border px-2 py-1.5 text-right outline-none transition',
        'focus:ring-2',
        invalid
          ? 'border-rose-400 focus:ring-rose-200'
          : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200 dark:border-slate-700 dark:focus:ring-slate-700',
        'dark:bg-slate-900 dark:text-slate-100',
      ].join(' ')}
    />
  );
}
