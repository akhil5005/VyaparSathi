import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { PrinterProfile } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

/**
 * Printer setup.
 *
 * Only a **network** printer can be driven from the server — it listens on TCP
 * 9100 and prints whatever bytes reach it. USB and Bluetooth printers hang off
 * the operator's own machine, so for those the API hands the ESC/POS back and
 * the browser delivers it. The form says which is which, because "why does the
 * test button not work for my USB printer" is otherwise a support call.
 */
export function PrintersSection() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail: string } | null>(
    null,
  );

  const printers = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.get<{ printers: PrinterProfile[] }>('/api/printing/printers'),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ reachable: boolean; detail: string }>(`/api/printing/printers/${id}/test`, {}),
    onSuccess(result, id) {
      setTestResult({ id, ok: result.reachable, detail: result.detail });
    },
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/api/printing/printers/${id}`, { isDefault: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['printers'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/printing/printers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['printers'] }),
  });

  const rows = printers.data?.printers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Where bills print. One is the default and is used unless another is chosen.
        </p>
        <Button onClick={() => setAdding(true)}>Add printer</Button>
      </div>

      <ErrorAlert error={setDefault.error ?? remove.error ?? test.error} />

      {printers.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5 text-slate-400" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500">No printer set up yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">
            Invoices can still be downloaded as PDF and printed from the browser — a profile is
            only needed for a thermal receipt printer.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((printer) => (
            <li
              key={printer.id}
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {printer.name}
                    {printer.isDefault ? (
                      <span className="ml-2 rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900">
                        default
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {printer.connection === 'NETWORK'
                      ? `Network · ${printer.ipAddress}:${printer.port ?? 9100}`
                      : `${printer.connection[0]}${printer.connection.slice(1).toLowerCase()} · sent by the browser`}
                    {' · '}
                    {printer.paperWidth === 'MM_58'
                      ? '58mm'
                      : printer.paperWidth === 'MM_80'
                        ? '80mm'
                        : printer.paperWidth}{' '}
                    · {printer.charactersPerLine} chars
                    {printer.copies > 1 ? ` · ${printer.copies} copies` : ''}
                  </p>
                </div>

                <div className="flex gap-1.5">
                  {printer.connection === 'NETWORK' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={test.isPending && test.variables === printer.id}
                      onClick={() => test.mutate(printer.id)}
                    >
                      Test
                    </Button>
                  ) : null}
                  {!printer.isDefault ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setDefault.mutate(printer.id)}
                    >
                      Make default
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(printer.id)}>
                    Remove
                  </Button>
                </div>
              </div>

              {testResult?.id === printer.id ? (
                <div className="mt-3">
                  <Alert tone={testResult.ok ? 'success' : 'warning'}>
                    {testResult.detail}
                    {testResult.ok ? (
                      // Worth saying: the socket opening proves the printer is
                      // on the network, not that it has paper in it.
                      <span className="block text-xs opacity-80">
                        The printer answered. That does not confirm it has paper.
                      </span>
                    ) : null}
                  </Alert>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? <AddPrinterDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function AddPrinterDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [connection, setConnection] = useState<PrinterProfile['connection']>('NETWORK');
  const [paperWidth, setPaperWidth] = useState<PrinterProfile['paperWidth']>('MM_80');
  const [ipAddress, setIpAddress] = useState('');
  const [port, setPort] = useState('9100');
  const [copies, setCopies] = useState('1');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/printing/printers', {
        name: name.trim(),
        connection,
        paperWidth,
        ...(connection === 'NETWORK' ? { ipAddress: ipAddress.trim(), port: port || '9100' } : {}),
        copies: copies || '1',
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['printers'] });
      onClose();
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready =
    name.trim().length > 0 &&
    (connection !== 'NETWORK' || ipAddress.trim().length > 0) &&
    !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add printer"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={create.error} />

        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors['name']}
          hint="Something you'd recognise — 'Counter thermal'"
          required
          autoFocus
          placeholder="Counter thermal"
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            How it's connected
          </legend>
          <div className="flex flex-wrap gap-2">
            {(['NETWORK', 'USB', 'BLUETOOTH', 'SYSTEM'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setConnection(option)}
                aria-pressed={connection === option}
                className={[
                  'rounded-lg border px-3 py-2 text-sm font-medium transition',
                  connection === option
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                ].join(' ')}
              >
                {option[0] + option.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </fieldset>

        {connection === 'NETWORK' ? (
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field
              label="IP address"
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              error={fieldErrors['ipAddress']}
              hint="Printed on the printer's self-test page"
              required
              className="font-mono"
              placeholder="192.168.1.50"
            />
            <Field
              label="Port"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              error={fieldErrors['port']}
              inputMode="numeric"
              hint="9100 normally"
              className="tabular"
            />
          </div>
        ) : (
          <Alert tone="info">
            The server can't reach a {connection.toLowerCase()} printer directly — it's attached to
            this machine, not the server. Bills are generated on the server and sent to the printer
            by the browser, so there's nothing to test from here.
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Paper
            </span>
            <select
              value={paperWidth}
              onChange={(e) => setPaperWidth(e.target.value as PrinterProfile['paperWidth'])}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
            >
              <option value="MM_80">80mm roll (48 characters)</option>
              <option value="MM_58">58mm roll (32 characters)</option>
              <option value="A4">A4</option>
              <option value="A5">A5</option>
            </select>
          </label>

          <Field
            label="Copies"
            value={copies}
            onChange={(e) => setCopies(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            error={fieldErrors['copies']}
            hint="Per print, max 5"
            className="tabular"
          />
        </div>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
