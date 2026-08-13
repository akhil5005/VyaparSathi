import { formatMoney, formatQuantity } from '../../lib/money';
import type { PurchaseLine } from '../../lib/types';
import type { PurchaseDraftLine } from './usePurchaseDraft';

/**
 * Purchase lines, with the conversion made visible.
 *
 * The column that earns its place is **landed** — what one stock unit actually
 * cost once freight is spread over the bill and reclaimable GST taken back out.
 * A mill bills 100 kg at ₹95; the shop sells reams at ₹240; whether that is a
 * good trade depends on a number nobody can do in their head, so it is printed
 * next to the line that produced it.
 */
export function PurchaseLinesTable({
  lines,
  pricedLines,
  onUpdate,
  onRemove,
}: {
  lines: PurchaseDraftLine[];
  pricedLines: PurchaseLine[] | undefined;
  onUpdate: (key: string, patch: Partial<PurchaseDraftLine>) => void;
  onRemove: (key: string) => void;
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
        No items yet.
      </p>
    );
  }

  // Priced lines are a prefix-matched subset — a half-typed row is not sent.
  let cursor = 0;
  const priceFor = (line: PurchaseDraftLine) =>
    Number(line.quantity) > 0 && line.rate !== '' ? pricedLines?.[cursor++] : undefined;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="pb-2 pr-2 font-medium">Item</th>
            <th className="px-2 pb-2 text-right font-medium">Qty</th>
            <th className="px-2 pb-2 font-medium">Unit</th>
            <th className="px-2 pb-2 text-right font-medium">Rate</th>
            <th className="px-2 pb-2 text-right font-medium">Value</th>
            <th className="px-2 pb-2 text-right font-medium">Landed</th>
            <th className="w-8 pb-2" />
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((line) => {
            const priced = priceFor(line);
            const converted =
              priced && priced.baseQuantity !== priced.quantity ? priced.baseQuantity : null;

            return (
              <tr key={line.key} className="align-top">
                <td className="py-2 pr-2">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {line.productName}
                  </p>
                  {converted ? (
                    // The whole point of the unit machinery, said plainly.
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      = {formatQuantity(converted)} in stock
                    </p>
                  ) : null}
                </td>

                <td className="px-2 py-2">
                  <NumberCell
                    value={line.quantity}
                    onChange={(quantity) => onUpdate(line.key, { quantity })}
                    ariaLabel={`Quantity for ${line.productName}`}
                  />
                </td>

                <td className="px-2 py-2">
                  {line.unitOptions.length > 1 ? (
                    <select
                      value={line.unitId}
                      aria-label={`Unit for ${line.productName}`}
                      onChange={(event) => {
                        const unit = line.unitOptions.find((u) => u.id === event.target.value);
                        onUpdate(line.key, {
                          unitId: event.target.value,
                          unitName: unit?.name ?? '',
                        });
                      }}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
                    >
                      {line.unitOptions.map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.symbol}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-slate-500">{line.unitName}</span>
                  )}
                </td>

                <td className="px-2 py-2">
                  <NumberCell
                    value={line.rate}
                    onChange={(rate) => onUpdate(line.key, { rate })}
                    ariaLabel={`Rate for ${line.productName}`}
                  />
                </td>

                <td className="tabular px-2 py-3 text-right text-slate-700 dark:text-slate-300">
                  {priced ? formatMoney(priced.taxableValue) : <Pending />}
                </td>

                <td className="tabular px-2 py-3 text-right">
                  {priced ? (
                    <>
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(priced.landedCostPerBaseUnit)}
                      </span>
                      {Number(priced.chargeShare) > 0 ? (
                        <p className="text-xs text-slate-400">
                          incl. {formatMoney(priced.chargeShare)} freight
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <Pending />
                  )}
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

/// Same reasoning as the sales table: text input, not number — a scroll wheel
/// over a focused rate field must not silently change a supplier's price.
function NumberCell({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === '' || /^\d*\.?\d*$/.test(next)) onChange(next);
      }}
      onFocus={(event) => event.target.select()}
      className="tabular w-20 rounded-md border border-slate-300 px-2 py-1.5 text-right outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
    />
  );
}
