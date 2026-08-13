import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/money';
import type { NoteListResponse } from '../../lib/types';
import { CAN_EDIT_MASTERS, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { NewCreditNoteDialog } from './NewCreditNoteDialog';
import { reasonLabel } from './reasons';

/**
 * Credit notes — the correct way to undo part of a sale.
 *
 * Cancelling an invoice erases the whole thing and spends its number; a credit
 * note leaves the original bill intact and issues a second numbered document
 * against it, which is what the GST return expects when goods come back or a
 * rate was wrong. The invoice screen points here for exactly that reason.
 *
 * The tax on a note is credited at the rate the **original invoice** carried,
 * not today's rate. If the Council revised the slab in between, crediting at
 * today's rate would hand back money that was never collected.
 */
export function NotesPage() {
  const { can } = useAuth();
  const canIssue = can(...CAN_EDIT_MASTERS);
  const [creating, setCreating] = useState(false);

  const notes = useQuery({
    queryKey: ['notes', 'list'],
    queryFn: () => api.get<NoteListResponse>('/api/notes', { query: { pageSize: 50 } }),
  });

  const rows = notes.data?.notes ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Credit notes
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Returns, short deliveries and rate corrections — without touching the original bill.
          </p>
        </div>
        {canIssue ? (
          <Button size="lg" onClick={() => setCreating(true)}>
            New credit note
          </Button>
        ) : null}
      </header>

      {notes.data && rows.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Credited to date" value={notes.data.totalValue} />
          <Stat label="Taxable value reversed" value={notes.data.totalTaxable} />
        </div>
      ) : null}

      {notes.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : notes.error ? (
        <ErrorAlert error={notes.error} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-14 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500">No credit notes yet.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            Raise one when goods come back, a delivery was short, or a rate was billed wrong. The
            original invoice stays exactly as issued.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Note</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Why</th>
                  <th className="px-3 py-2.5 font-medium">Stock</th>
                  <th className="px-4 py-2.5 text-right font-medium">Credited</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((note) => {
                  const cancelled = note.status === 'CANCELLED';
                  return (
                    <tr key={note.id} className={cancelled ? 'opacity-50' : ''}>
                      <td className="px-4 py-3">
                        <p
                          className={`font-mono text-xs text-slate-900 dark:text-slate-100 ${cancelled ? 'line-through' : ''}`}
                        >
                          {note.noteNumber ?? 'Draft'}
                        </p>
                        <p className="text-xs text-slate-500">{formatDate(note.noteDate)}</p>
                      </td>

                      <td className="px-3 py-3 text-slate-900 dark:text-slate-100">
                        {note.party?.displayName ?? note.partyName}
                      </td>

                      <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
                        {reasonLabel(note.reason)}
                        {note.reasonNote ? (
                          <span className="block text-xs text-slate-400">{note.reasonNote}</span>
                        ) : null}
                      </td>

                      <td className="px-3 py-3 text-xs">
                        {note.affectsStock ? (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            Came back
                          </span>
                        ) : (
                          <span className="text-slate-400">Money only</span>
                        )}
                      </td>

                      <td className="tabular px-4 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(note.grandTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Alert tone="info">
        A credit note reverses tax at the rate on the <strong>original</strong> invoice, not
        today's. If a GST slab changed in between, crediting at today's rate would hand back money
        that was never collected.
      </Alert>

      {creating ? <NewCreditNoteDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {formatMoney(value)}
      </p>
    </div>
  );
}
