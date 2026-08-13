import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { STATE_CODES, validateGstin } from '../../lib/gstin';
import type { PartyListItem } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Adding a customer without leaving the bill.
 *
 * A walk-in turning up at the counter is the common case, and making the
 * operator abandon a half-typed bill to go and create a party record is exactly
 * the kind of friction that gets software abandoned. Billing staff are allowed
 * to create a party but not to edit one, which is enforced on the server.
 *
 * The state code matters more than it looks: it is what decides CGST+SGST
 * versus IGST on every bill this customer is ever given. With a GSTIN it is
 * read from the first two digits; without one it has to be asked for.
 */
export function NewCustomerDialog({
  initialName,
  onCancel,
  onCreated,
}: {
  initialName: string;
  onCancel: () => void;
  onCreated: (party: PartyListItem) => void;
}) {
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState(initialName);
  const [gstin, setGstin] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  // Punjab, since almost every customer is local. Changed when they aren't.
  const [stateCode, setStateCode] = useState('03');

  const gstinCheck = useMemo(() => (gstin.trim() ? validateGstin(gstin) : null), [gstin]);
  const registered = gstinCheck?.valid === true;

  const create = useMutation({
    mutationFn: () =>
      api.post<{ party: PartyListItem }>('/api/masters/parties', {
        displayName: displayName.trim(),
        partyType: 'CUSTOMER',
        ...(registered
          ? { gstin: gstin.trim().toUpperCase() }
          : // Without a GSTIN the server needs the state code explicitly.
            { stateCode }),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
      }),
    onSuccess(result) {
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      // The list endpoint adds these; a freshly created party has neither.
      onCreated({ ...result.party, currentBalance: '0', overCreditLimit: false });
    },
  });

  const serverFields = create.error instanceof ApiError ? create.error.fieldErrors : {};

  const ready =
    displayName.trim().length >= 2 && (registered || Boolean(stateCode)) && !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="New customer"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending} disabled={!ready}>
            Add and continue
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={create.error} />

        <Field
          label="Name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={serverFields['displayName']}
          required
          autoFocus
        />

        <Field
          label="GSTIN"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase().slice(0, 15))}
          error={
            serverFields['gstin'] ??
            (gstin.length === 15 && !registered ? gstinCheck?.reason : undefined)
          }
          hint={
            registered ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                ✓ {gstinCheck?.stateName} — tax split will follow this
              </span>
            ) : (
              'Leave blank for an unregistered customer'
            )
          }
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          placeholder="03AABCM1234C1ZX"
        />

        {!registered ? (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              State <span className="text-rose-600">*</span>
            </span>
            <select
              value={stateCode}
              onChange={(event) => setStateCode(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
            >
              {Object.entries(STATE_CODES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-sm text-slate-500">
              Decides CGST+SGST or IGST on their bills
            </span>
          </label>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={serverFields['phone']}
            inputMode="tel"
            placeholder="9876543210"
          />
          <Field
            label="City"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            error={serverFields['city']}
            placeholder="Ludhiana"
          />
        </div>

        {/* Submits the form on Enter without adding a visible second button. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
