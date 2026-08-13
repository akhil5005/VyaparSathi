import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { STATE_CODES, validateGstin } from '../../lib/gstin';
import { todayInput } from '../../lib/money';
import type { PartyDetail, PartyType } from '../../lib/types';
import { CAN_EDIT_MASTERS, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Adding a customer or supplier properly.
 *
 * The billing screen has a cut-down version of this for a walk-in mid-sale;
 * this is the full record — credit terms, address, and the opening balance
 * carried over from the old books.
 *
 * Opening balance is **set once and never edited**, which the server enforces:
 * changing it later would silently desync the ledger from the entries that
 * built it. Correcting it afterwards means an adjustment entry, not a rewrite.
 */

const TYPES: { id: PartyType; label: string; hint: string }[] = [
  { id: 'CUSTOMER', label: 'Customer', hint: 'Buys from you' },
  { id: 'SUPPLIER', label: 'Supplier', hint: 'You buy from them' },
  { id: 'BOTH', label: 'Both', hint: 'Trades both ways' },
];

export function NewPartyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (partyId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  // Counter staff may add a walk-in but not set credit terms or balances.
  const canSetTerms = can(...CAN_EDIT_MASTERS);

  const [displayName, setDisplayName] = useState('');
  const [partyType, setPartyType] = useState<PartyType>('CUSTOMER');
  const [gstin, setGstin] = useState('');
  const [stateCode, setStateCode] = useState('03');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [creditDays, setCreditDays] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');

  const gstinCheck = useMemo(() => (gstin.trim() ? validateGstin(gstin) : null), [gstin]);
  const registered = gstinCheck?.valid === true;

  const create = useMutation({
    mutationFn: () =>
      api.post<{ party: PartyDetail }>('/api/masters/parties', {
        displayName: displayName.trim(),
        partyType,
        ...(registered
          ? { gstin: gstin.trim().toUpperCase() }
          : // Without a GSTIN the server needs the state explicitly — it is
            // what decides CGST+SGST versus IGST on every future bill.
            { stateCode }),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(addressLine1.trim() ? { addressLine1: addressLine1.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(pincode.trim() ? { pincode: pincode.trim() } : {}),
        ...(canSetTerms && creditDays !== '' ? { creditDays: Number(creditDays) } : {}),
        ...(canSetTerms && creditLimit !== '' ? { creditLimit } : {}),
        ...(canSetTerms && Number(openingBalance) !== 0
          ? { openingBalance, openingBalanceDate: todayInput() }
          : {}),
      }),
    onSuccess(result) {
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
      onCreated(result.party.id);
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready = displayName.trim().length >= 2 && !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add customer or supplier"
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
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldErrors['displayName']}
          required
          autoFocus
          placeholder="Sharma Stationery"
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            They are a
          </legend>
          <div className="flex flex-wrap gap-2">
            {TYPES.map(({ id, label, hint }) => (
              <button
                key={id}
                type="button"
                onClick={() => setPartyType(id)}
                aria-pressed={partyType === id}
                title={hint}
                className={[
                  'rounded-lg border px-3 py-2 text-sm font-medium transition',
                  partyType === id
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <Field
          label="GSTIN"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase().slice(0, 15))}
          error={
            fieldErrors['gstin'] ??
            (gstin.length === 15 && !registered ? gstinCheck?.reason : undefined)
          }
          hint={
            registered ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                ✓ {gstinCheck?.stateName}
              </span>
            ) : (
              'Leave blank if unregistered'
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
            error={fieldErrors['phone']}
            inputMode="tel"
            placeholder="9876543210"
          />
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors['email']}
          />
        </div>

        <Field
          label="Address"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
          error={fieldErrors['addressLine1']}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="City"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            error={fieldErrors['city']}
            placeholder="Ludhiana"
          />
          <Field
            label="Pincode"
            value={pincode}
            onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            error={fieldErrors['pincode']}
            inputMode="numeric"
            placeholder="141008"
          />
        </div>

        {canSetTerms ? (
          <fieldset className="space-y-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-sm font-medium text-slate-700 dark:text-slate-300">
              Credit and opening balance
            </legend>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Credit days"
                value={creditDays}
                onChange={(e) => setCreditDays(e.target.value.replace(/\D/g, ''))}
                error={fieldErrors['creditDays']}
                inputMode="numeric"
                hint="Bills age from the due date"
                className="tabular"
                placeholder="30"
              />
              <Field
                label="Credit limit"
                value={creditLimit}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '' || /^\d*\.?\d*$/.test(v)) setCreditLimit(v);
                }}
                error={fieldErrors['creditLimit']}
                inputMode="decimal"
                hint="Warns at billing time"
                className="tabular"
                placeholder="50000"
              />
            </div>

            <Field
              label="Opening balance"
              value={openingBalance}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || v === '-' || /^-?\d*\.?\d*$/.test(v)) setOpeningBalance(v);
              }}
              error={fieldErrors['openingBalance']}
              inputMode="decimal"
              hint="What they already owe you on the switchover date. Negative if you owe them."
              className="tabular"
              placeholder="0"
            />

            {Number(openingBalance) !== 0 && openingBalance !== '' ? (
              <Alert tone="warning">
                This is set once and cannot be edited afterwards — changing it later would put the
                ledger out of step with the entries that built it. Check it against the old book
                before saving.
              </Alert>
            ) : null}
          </fieldset>
        ) : null}

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
