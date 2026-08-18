import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatDate, formatMoney } from '../../lib/money';
import type {
  LedgerEntry,
  PartyListItem,
  PartyListResponse,
  PartyLedgerResponse,
} from '../../lib/types';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { Field } from '../../components/Field';
import { Combobox, type ComboboxHandle } from '../../components/Combobox';
import { Pagination, usePage } from '../../components/Pagination';
import { useAuth } from '../../auth/AuthProvider';
import { readBalance } from '../parties/balance';

/**
 * One firm's account, in full.
 *
 * The party dialog answers "what happened lately"; this answers "show me the
 * year". They read the same rows from the same endpoint and differ in three
 * ways that matter: this one runs oldest-first like a printed bahi khata, it
 * opens with the balance brought forward from before the period, and it has
 * room for a year of entries without a modal's scrollbar.
 *
 * **There is one account per firm, not per role.** A mill that sells you reels
 * and buys back your cut waste appears once. Sales and debit notes debit the
 * account, purchases and credit notes credit it, receipts credit and payments
 * debit — so the two directions net off on one page and the closing balance is
 * the single number that says who owes whom.
 */

const PAGE_SIZE = 50;

/**
 * The Indian financial year runs April to March, so "this year" is not the
 * calendar year and a CA asking for a statement means this window.
 *
 * `fyStartMonth` is 1-based and comes from the shop's own record rather than
 * being hardcoded to April. It defaults to 4 and in this trade will never be
 * anything else — but the server already treats it as configurable, and a
 * preset that quietly disagreed with the server's idea of a financial year
 * would produce a statement whose boundaries nobody could explain.
 */
function financialYear(
  fyStartMonth: number,
  offset = 0,
): { from: string; to: string; label: string } {
  const now = new Date();
  const startYear =
    (now.getMonth() + 1 >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1) + offset;

  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${startYear}-${pad(fyStartMonth)}-01`;
  // The instant before the next year's start, expressed as a date. Going via
  // day 0 of the following month avoids hardcoding 31 March and gets February
  // right when the start month is not April.
  const end = new Date(Date.UTC(startYear + 1, fyStartMonth - 1, 0));
  const to = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;

  return {
    from,
    to,
    label: `FY ${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

export function LedgerPage() {
  const { business } = useAuth();
  // Only the id is held here — the name shown in the heading comes back with
  // the ledger, so there is no second copy to drift out of step.
  const [partyId, setPartyId] = useState('');
  const [partyQuery, setPartyQuery] = useState('');

  const fyStartMonth = business?.fyStartMonth ?? 4;
  const thisYear = useMemo(() => financialYear(fyStartMonth), [fyStartMonth]);
  const lastYear = useMemo(() => financialYear(fyStartMonth, -1), [fyStartMonth]);

  const [fromDate, setFromDate] = useState(thisYear.from);
  const [toDate, setToDate] = useState(thisYear.to);

  const [page, setPage] = usePage([partyId, fromDate, toDate]);
  const partyBox = useRef<ComboboxHandle>(null);
  const debouncedParty = useDebounced(partyQuery);

  const parties = useQuery({
    queryKey: ['parties', 'search', debouncedParty],
    queryFn: () =>
      api.get<PartyListResponse>('/api/masters/parties', {
        query: { search: debouncedParty, pageSize: 8, isActive: true },
      }),
    enabled: debouncedParty.trim().length > 0,
  });

  const ledger = useQuery({
    queryKey: ['parties', partyId, 'ledger', 'page-view', fromDate, toDate, page],
    queryFn: () =>
      api.get<PartyLedgerResponse>(`/api/masters/parties/${partyId}/ledger`, {
        query: {
          page,
          pageSize: PAGE_SIZE,
          order: 'asc',
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
        },
      }),
    enabled: Boolean(partyId),
  });

  const data = ledger.data;
  const opening = readBalance(data?.openingBalance);
  const closing = readBalance(data?.closingBalance);

  function applyYear(year: { from: string; to: string }) {
    setFromDate(year.from);
    setToDate(year.to);
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Ledger
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          One account per firm — what you sold them and what you bought from them, on the same page.
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr]">
          <Combobox<PartyListItem>
            ref={partyBox}
            label="Customer or supplier"
            placeholder="Name, phone or GSTIN…"
            autoFocus
            items={parties.data?.parties ?? []}
            loading={parties.isFetching}
            pending={partyQuery.trim() !== debouncedParty.trim() || parties.isFetching}
            itemKey={(p) => p.id}
            itemLabel={(p) => p.displayName}
            onSearch={setPartyQuery}
            onSelect={(p) => setPartyId(p.id)}
            renderItem={(p) => {
              const balance = readBalance(p.currentBalance);
              return (
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">{p.displayName}</span>
                  {balance.direction !== 'settled' ? (
                    <span className={`tabular shrink-0 text-xs ${balance.tone}`}>
                      {balance.amount} {balance.direction === 'owed-to-us' ? 'Dr' : 'Cr'}
                    </span>
                  ) : null}
                </div>
              );
            }}
          />

          <Field
            label="From"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
          <Field
            label="To"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Quick range:</span>
          {[thisYear, lastYear].map((year) => (
            <button
              key={year.label}
              type="button"
              onClick={() => applyYear(year)}
              aria-pressed={fromDate === year.from && toDate === year.to}
              className={[
                'rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                fromDate === year.from && toDate === year.to
                  ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
              ].join(' ')}
            >
              {year.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setFromDate('');
              setToDate('');
            }}
            aria-pressed={!fromDate && !toDate}
            className={[
              'rounded-lg border px-2.5 py-1 text-xs font-medium transition',
              !fromDate && !toDate
                ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
            ].join(' ')}
          >
            Everything
          </button>
        </div>
      </div>

      {!partyId ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-20 text-center text-sm text-slate-500 dark:border-slate-700">
          Pick a customer or supplier to see their account.
        </p>
      ) : ledger.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : ledger.error ? (
        <ErrorAlert error={ledger.error} />
      ) : data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {data.party.displayName}
              <span className="ml-2 rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-slate-300 dark:ring-slate-700">
                {data.party.partyType === 'BOTH'
                  ? 'Customer & supplier'
                  : data.party.partyType.toLowerCase()}
              </span>
            </h2>
            <p className="text-sm text-slate-500">
              {fromDate || toDate
                ? `${fromDate ? formatDate(fromDate) : 'the beginning'} to ${
                    toDate ? formatDate(toDate) : 'today'
                  }`
                : 'The whole account'}
            </p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Particulars</th>
                  <th className="px-3 py-2.5 text-right font-medium">Debit</th>
                  <th className="px-3 py-2.5 text-right font-medium">Credit</th>
                  <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {/* Only meaningful on page one of a date-filtered view: the rows
                    below continue from here rather than from zero. */}
                {page === 1 && (fromDate || toDate) ? (
                  <tr className="bg-slate-50/60 dark:bg-slate-800/30">
                    <td className="px-4 py-2.5 text-slate-500">
                      {fromDate ? formatDate(fromDate) : ''}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-700 dark:text-slate-300">
                      Opening balance
                    </td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5" />
                    <td className={`tabular px-4 py-2.5 text-right font-medium ${opening.tone}`}>
                      <Signed balance={opening} />
                    </td>
                  </tr>
                ) : null}

                {data.entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-14 text-center text-sm text-slate-500">
                      Nothing on this account in that period.
                    </td>
                  </tr>
                ) : (
                  data.entries.map((entry) => <Row key={entry.id} entry={entry} />)
                )}
              </tbody>

              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-semibold dark:border-slate-700 dark:bg-slate-800/50">
                  <td className="px-4 py-3" />
                  <td className="px-3 py-3 text-slate-900 dark:text-slate-100">Closing balance</td>
                  <td className="tabular px-3 py-3 text-right text-slate-700 dark:text-slate-300">
                    {formatMoney(data.totalDebit)}
                  </td>
                  <td className="tabular px-3 py-3 text-right text-slate-700 dark:text-slate-300">
                    {formatMoney(data.totalCredit)}
                  </td>
                  <td className={`tabular px-4 py-3 text-right ${closing.tone}`}>
                    <Signed balance={closing} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Spelled out, because Dr/Cr is precise but not everyone reads it
              fluently, and this is the sentence the argument at the counter is
              actually about. */}
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {closing.direction === 'settled'
              ? `${data.party.displayName} is settled up.`
              : closing.direction === 'owed-to-us'
                ? `${data.party.displayName} owes you ${closing.amount}.`
                : `You owe ${data.party.displayName} ${closing.amount}.`}
          </p>

          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={setPage}
            noun="entries"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Voucher types as the server writes them on the ledger — the short `RECEIPT`
 * and `PAYMENT`, not the longer `DocumentType` names.
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

const voucherLabel = (type: string): string =>
  VOUCHER_LABEL[type] ??
  type
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());

function Row({ entry }: { entry: LedgerEntry }) {
  const running = readBalance(entry.runningBalance);

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
        {formatDate(entry.entryDate)}
      </td>

      <td className="px-3 py-2.5">
        <p className="text-slate-900 dark:text-slate-100">
          {voucherLabel(entry.voucherType)}
          {entry.voucherNumber ? (
            <span className="ml-1.5 font-mono text-xs text-slate-500">{entry.voucherNumber}</span>
          ) : null}
        </p>
        {entry.narration ? (
          <p className="text-xs text-slate-500">{entry.narration}</p>
        ) : null}
      </td>

      <td className="tabular px-3 py-2.5 text-right text-slate-700 dark:text-slate-300">
        {Number(entry.debit) > 0 ? formatMoney(entry.debit) : <Dash />}
      </td>

      <td className="tabular px-3 py-2.5 text-right text-slate-700 dark:text-slate-300">
        {Number(entry.credit) > 0 ? formatMoney(entry.credit) : <Dash />}
      </td>

      <td className={`tabular px-4 py-2.5 text-right font-medium ${running.tone}`}>
        <Signed balance={running} />
      </td>
    </tr>
  );
}

/// Dr/Cr rather than a minus sign — the notation the CA and the paper book use.
function Signed({ balance }: { balance: ReturnType<typeof readBalance> }) {
  if (balance.direction === 'settled') return <>{formatMoney('0')}</>;
  return (
    <>
      {balance.amount}
      <span className="ml-1 text-xs font-normal text-slate-400">
        {balance.direction === 'owed-to-us' ? 'Dr' : 'Cr'}
      </span>
    </>
  );
}

const Dash = () => <span className="text-slate-300 dark:text-slate-700">—</span>;
