import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import type { PartyListResponse, PartyType } from '../../lib/types';
import { CAN_BILL, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { readBalance } from './balance';
import { PartyDetailDialog } from './PartyDetailDialog';
import { NewPartyDialog } from './NewPartyDialog';

/**
 * Everyone the shop trades with, customers and suppliers together.
 *
 * They share a table because they share a ledger: the same firm can buy paper
 * from you on Monday and sell you board on Friday, and its balance is one
 * running figure either way. Splitting them into two screens would mean two
 * half-answers to "what is our position with them".
 */

const TYPE_FILTERS: { id: PartyType | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Everyone' },
  { id: 'CUSTOMER', label: 'Customers' },
  { id: 'SUPPLIER', label: 'Suppliers' },
];

export function PartiesPage() {
  const { can } = useAuth();
  const canCreate = can(...CAN_BILL);

  const [search, setSearch] = useState('');
  const [type, setType] = useState<PartyType | 'ALL'>('ALL');
  const [withBalanceOnly, setWithBalanceOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const debouncedSearch = useDebounced(search);

  const parties = useQuery({
    queryKey: ['parties', 'list', debouncedSearch, type, withBalanceOnly],
    queryFn: () =>
      api.get<PartyListResponse>('/api/masters/parties', {
        query: {
          search: debouncedSearch || undefined,
          partyType: type === 'ALL' ? undefined : type,
          withBalanceOnly: withBalanceOnly || undefined,
          pageSize: 100,
        },
      }),
  });

  const rows = parties.data?.parties ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Customers &amp; suppliers
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {parties.data ? `${parties.data.total} in the book` : ' '}
          </p>
        </div>
        {canCreate ? (
          <Button size="lg" onClick={() => setCreating(true)}>
            Add
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, phone or GSTIN…"
          className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
        />

        <div className="flex gap-1.5">
          {TYPE_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setType(id)}
              aria-pressed={type === id}
              className={[
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition',
                type === id
                  ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={withBalanceOnly}
            onChange={(event) => setWithBalanceOnly(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Only with a balance
        </label>
      </div>

      {parties.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : parties.error ? (
        <ErrorAlert error={parties.error} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
          Nobody matches that.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">GSTIN</th>
                  <th className="px-3 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((party) => {
                  const balance = readBalance(party.currentBalance);

                  return (
                    <tr
                      key={party.id}
                      onClick={() => setOpenId(party.id)}
                      tabIndex={0}
                      role="button"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpenId(party.id);
                        }
                      }}
                      className={[
                        'cursor-pointer focus:outline-none',
                        party.isActive
                          ? 'hover:bg-slate-50 focus:bg-slate-50 dark:hover:bg-slate-800/40 dark:focus:bg-slate-800/40'
                          : 'opacity-50',
                      ].join(' ')}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {party.displayName}
                        </p>
                        <p className="text-xs text-slate-500">
                          {[party.phone, party.city].filter(Boolean).join(' · ') || party.stateName}
                        </p>
                      </td>

                      <td className="px-3 py-3 font-mono text-xs text-slate-500">
                        {party.gstin ?? <span className="font-sans">Unregistered</span>}
                      </td>

                      <td className="px-3 py-3 text-xs text-slate-500">
                        {party.partyType === 'BOTH'
                          ? 'Customer & supplier'
                          : party.partyType === 'CUSTOMER'
                            ? 'Customer'
                            : 'Supplier'}
                      </td>

                      <td className="px-4 py-3 text-right">
                        {balance.direction === 'settled' ? (
                          <span className="text-xs text-slate-400">Settled</span>
                        ) : (
                          <>
                            <span className={`tabular font-medium ${balance.tone}`}>
                              {balance.amount}
                            </span>
                            <p className="text-xs text-slate-500">{balance.phrase}</p>
                          </>
                        )}
                        {party.overCreditLimit ? (
                          <p className="text-xs text-rose-600 dark:text-rose-400">
                            Over credit limit
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openId ? (
        <PartyDetailDialog partyId={openId} onClose={() => setOpenId(null)} />
      ) : null}

      {creating ? (
        <NewPartyDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      ) : null}
    </div>
  );
}
