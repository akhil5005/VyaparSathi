import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/money';
import type { LedgerEntry, PartyDetail, PartyLedgerResponse } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { readBalance } from './balance';

/**
 * One party, and their account.
 *
 * The ledger is the point. "How much does Sharma owe?" is answered on the list;
 * "why?" is answered here, line by line, with a running balance that can be
 * read against the paper bahi khata it replaces. Every entry names the document
 * that caused it, so a disputed figure resolves to an invoice number rather
 * than an argument.
 */
export function PartyDetailDialog({
  partyId,
  onClose,
}: {
  partyId: string;
  onClose: () => void;
}) {
  const party = useQuery({
    queryKey: ['parties', partyId],
    queryFn: () => api.get<{ party: PartyDetail }>(`/api/masters/parties/${partyId}`),
  });

  const ledger = useQuery({
    queryKey: ['parties', partyId, 'ledger'],
    queryFn: () =>
      api.get<PartyLedgerResponse>(`/api/masters/parties/${partyId}/ledger`, {
        query: { pageSize: 50 },
      }),
  });

  const p = party.data?.party;
  const balance = readBalance(p?.currentBalance);

  /**
   * Entries newest-first, ordered by when they were **written**.
   *
   * The server orders by `entryDate`, which is the right instinct for a ledger
   * but breaks the running-balance column here. An invoice's entryDate carries
   * a time; a payment's is midnight, because it comes from a date input. So on
   * a day with both, the payment sorts ahead of the sale that caused it and the
   * balances read 0 → 2,832 → 1,832 → 1,032 — an account that looks broken.
   *
   * `runningBalance` was computed at insert time, so `createdAt` is the only
   * order in which that column is coherent. Sorting by it makes each row's
   * balance genuinely follow from the one below.
   *
   * Worth noting the limitation: the server paginates by entryDate, so on a
   * party with more than one page of history this reorders within the page
   * rather than across the whole account. Fixing that properly means ordering
   * by `createdAt` server-side too.
   */
  const entries = [...(ledger.data?.entries ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title={p?.displayName ?? 'Party'}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {party.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : party.error ? (
        <ErrorAlert error={party.error} />
      ) : p ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
              <p className="text-xs text-slate-500">
                {balance.direction === 'settled' ? 'Account' : balance.phrase}
              </p>
              <p className={`tabular text-xl font-semibold ${balance.tone}`}>
                {balance.direction === 'settled' ? 'Settled up' : balance.amount}
              </p>
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
              <p className="text-xs text-slate-500">Billed to date</p>
              <p className="tabular text-xl font-semibold text-slate-900 dark:text-slate-100">
                {formatMoney(p.stats.totalBilled)}
              </p>
              <p className="text-xs text-slate-400">
                {p.stats.invoiceCount} invoice{p.stats.invoiceCount === 1 ? '' : 's'}
              </p>
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
              <p className="text-xs text-slate-500">Credit terms</p>
              <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {p.creditDays ? `${p.creditDays} days` : 'None'}
              </p>
              {p.creditLimit ? (
                <p className="text-xs text-slate-400">Limit {formatMoney(p.creditLimit)}</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="GSTIN">
              <span className="font-mono">{p.gstin ?? 'Unregistered'}</span>
              {/* The state code is what decides CGST+SGST vs IGST on every bill
                  this party is ever given, so it is always shown. */}
              <span className="ml-2 text-xs text-slate-500">
                {p.stateName} ({p.stateCode})
              </span>
            </Detail>

            <Detail label="Contact">
              {[p.phone, p.email].filter(Boolean).join(' · ') || '—'}
              {p.contactPerson ? (
                <span className="text-slate-500"> · {p.contactPerson}</span>
              ) : null}
            </Detail>

            <Detail label="Address">
              {[p.addressLine1, p.addressLine2, p.city, p.pincode].filter(Boolean).join(', ') ||
                '—'}
            </Detail>

            <Detail label="Opening balance">
              {formatMoney(p.openingBalance)}
              {p.openingBalanceDate ? (
                <span className="text-slate-500"> as at {formatDate(p.openingBalanceDate)}</span>
              ) : null}
            </Detail>
          </div>

          {p.partyRates.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Agreed rates
              </h3>
              <ul className="space-y-0.5 text-sm">
                {p.partyRates.map((rate) => (
                  <li key={rate.id} className="flex justify-between gap-3">
                    <span className="text-slate-700 dark:text-slate-300">
                      {rate.product?.name ?? 'Product'}
                      <span className="text-slate-500"> per {rate.unit?.symbol ?? 'unit'}</span>
                    </span>
                    <span className="tabular text-slate-900 dark:text-slate-100">
                      {formatMoney(rate.rate)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ---- Ledger ---- */}
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Account</h3>
              {ledger.data ? (
                <p className="text-xs text-slate-500">
                  Billed {formatMoney(ledger.data.totalDebit)} · Received{' '}
                  {formatMoney(ledger.data.totalCredit)}
                </p>
              ) : null}
            </div>

            {ledger.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner className="h-5 w-5 text-slate-400" />
              </div>
            ) : ledger.error ? (
              <ErrorAlert error={ledger.error} />
            ) : entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">
                Nothing on the account yet.
              </p>
            ) : (
              <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2 font-medium">Entry</th>
                      <th className="px-2 py-2 text-right font-medium">Billed</th>
                      <th className="px-2 py-2 text-right font-medium">Received</th>
                      <th className="px-3 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {entries.map((entry) => (
                      <LedgerRow key={entry.id} entry={entry} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Voucher types as the **server** actually writes them, read off live ledger
 * rows rather than guessed from the document-type enum.
 *
 * An earlier version of this map used `PAYMENT_RECEIPT` and `PAYMENT_VOUCHER`,
 * which are the names in `DocumentType`. The ledger uses the shorter `RECEIPT`
 * and `PAYMENT`, so every payment line in the account rendered as a raw
 * shouty constant.
 */
const VOUCHER_LABEL: Record<string, string> = {
  SALES_INVOICE: 'Sale',
  PURCHASE_INVOICE: 'Purchase',
  RECEIPT: 'Payment received',
  PAYMENT: 'Payment made',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
  OPENING_BALANCE: 'Opening balance',
  ADJUSTMENT: 'Adjustment',
  CHEQUE_BOUNCE: 'Cheque bounced',
};

/// Anything unmapped is title-cased rather than shown as SCREAMING_SNAKE.
const voucherLabel = (type: string): string =>
  VOUCHER_LABEL[type] ??
  type
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const running = readBalance(entry.runningBalance);

  return (
    <tr>
      <td className="px-3 py-2">
        <p className="text-slate-900 dark:text-slate-100">
          {voucherLabel(entry.voucherType)}
          {entry.voucherNumber ? (
            <span className="ml-1.5 font-mono text-xs text-slate-500">{entry.voucherNumber}</span>
          ) : null}
        </p>
        <p className="text-xs text-slate-500">
          {formatDate(entry.entryDate)}
          {entry.narration ? ` · ${entry.narration}` : ''}
        </p>
      </td>

      <td className="tabular px-2 py-2 text-right text-slate-700 dark:text-slate-300">
        {Number(entry.debit) > 0 ? formatMoney(entry.debit) : <Dash />}
      </td>

      <td className="tabular px-2 py-2 text-right text-slate-700 dark:text-slate-300">
        {Number(entry.credit) > 0 ? formatMoney(entry.credit) : <Dash />}
      </td>

      <td className={`tabular px-3 py-2 text-right font-medium ${running.tone}`}>
        {running.direction === 'settled' ? formatMoney('0') : running.amount}
        {/* Cr/Dr rather than a minus sign — this is a ledger, and that is the
            notation the CA and the old paper book both use. */}
        {running.direction !== 'settled' ? (
          <span className="ml-1 text-xs font-normal text-slate-400">
            {running.direction === 'owed-to-us' ? 'Dr' : 'Cr'}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

const Dash = () => <span className="text-slate-300 dark:text-slate-700">—</span>;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 text-slate-700 dark:text-slate-300">{children}</div>
    </div>
  );
}
