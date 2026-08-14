import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { STATE_CODES, validateGstin } from '../../lib/gstin';
import type { PartyDetail, PartyType } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Correcting a customer or supplier.
 *
 * The consequential field is the GSTIN, because its first two digits are the
 * state code, and the state code is what decides CGST+SGST versus IGST on every
 * bill this party is ever given. Change it and the tax on future bills changes
 * with it — so the state is shown, live, as it is typed.
 *
 * Opening balance is deliberately absent. It was set once at the switchover
 * from the old books and the whole ledger is built on it; editing it later
 * would leave the account no longer adding up. A wrong opening figure is
 * corrected with an adjustment entry, which is visible in the account, rather
 * than by quietly rewriting where the account started.
 */
export function EditPartyDialog({
  party,
  onClose,
  onSaved,
}: {
  party: PartyDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState(party.displayName);
  const [legalName, setLegalName] = useState(party.legalName ?? '');
  const [partyType, setPartyType] = useState<PartyType>(party.partyType);
  const [gstin, setGstin] = useState(party.gstin ?? '');
  const [stateCode, setStateCode] = useState(party.stateCode);
  const [phone, setPhone] = useState(party.phone ?? '');
  const [email, setEmail] = useState(party.email ?? '');
  const [contactPerson, setContactPerson] = useState(party.contactPerson ?? '');
  const [addressLine1, setAddressLine1] = useState(party.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(party.addressLine2 ?? '');
  const [city, setCity] = useState(party.city ?? '');
  const [pincode, setPincode] = useState(party.pincode ?? '');
  const [creditLimit, setCreditLimit] = useState(party.creditLimit ?? '');
  const [creditDays, setCreditDays] = useState(party.creditDays ? String(party.creditDays) : '');
  const [isActive, setIsActive] = useState(party.isActive);

  /// A GSTIN carries its own state; only an unregistered party needs one typed.
  const gstinCheck = useMemo(() => (gstin.trim() ? validateGstin(gstin) : null), [gstin]);
  const effectiveState = gstinCheck?.stateCode ?? stateCode;
  const stateChanged = effectiveState !== party.stateCode;

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ party: PartyDetail }>(`/api/masters/parties/${party.id}`, {
        displayName: displayName.trim(),
        legalName: legalName.trim(),
        partyType,
        // Explicitly null when cleared, not omitted — a PATCH ignores what it
        // is not given, so omitting it would leave them registered and the
        // change would look as though it had not saved.
        ...(gstin.trim()
          ? { gstin: gstin.trim().toUpperCase() }
          : { gstin: null, stateCode: effectiveState }),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        contactPerson: contactPerson.trim(),
        addressLine1: addressLine1.trim(),
        addressLine2: addressLine2.trim(),
        city: city.trim(),
        ...(pincode.trim() ? { pincode: pincode.trim() } : {}),
        ...(creditLimit !== '' ? { creditLimit: String(creditLimit) } : {}),
        ...(creditDays !== '' ? { creditDays: Number(creditDays) } : {}),
        isActive,
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      onSaved();
    },
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const ready = displayName.trim().length >= 2 && !save.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) save.mutate();
  }

  const owesSomething = Number(party.currentBalance) !== 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${party.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={save.isPending} disabled={!ready}>
            Save changes
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={save.error} />

        <Field
          label="Name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldErrors['displayName']}
          hint="What you call them"
          required
          autoFocus
        />

        <Field
          label="Legal name"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          error={fieldErrors['legalName']}
          hint="As printed on their GST certificate, if different"
        />

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
            They are a
          </span>
          <select
            value={partyType}
            onChange={(event) => setPartyType(event.target.value as PartyType)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
          >
            <option value="CUSTOMER">Customer</option>
            <option value="SUPPLIER">Supplier</option>
            <option value="BOTH">Both — buys and sells</option>
          </select>
        </label>

        <Field
          label="GSTIN"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, ''))}
          className="font-mono"
          maxLength={15}
          error={fieldErrors['gstin'] ?? (gstinCheck && !gstinCheck.valid ? gstinCheck.reason : undefined)}
          hint={
            gstinCheck?.valid
              ? `${gstinCheck.stateName} (${gstinCheck.stateCode})`
              : 'Leave blank for an unregistered customer'
          }
        />

        {!gstin.trim() ? (
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
                  {name} ({code})
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-sm text-slate-500">
              Decides CGST+SGST vs IGST on every bill they are given.
            </span>
          </label>
        ) : null}

        {stateChanged ? (
          <Alert tone="warning">
            Their state changes from {STATE_CODES[party.stateCode] ?? party.stateCode} to{' '}
            {STATE_CODES[effectiveState] ?? effectiveState}. That changes how future bills are
            taxed — CGST+SGST within your own state, IGST outside it. Bills already issued keep the
            tax they were issued with.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={fieldErrors['phone']}
            inputMode="tel"
          />
          <Field
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors['email']}
            type="email"
          />
        </div>

        <Field
          label="Contact person"
          value={contactPerson}
          onChange={(e) => setContactPerson(e.target.value)}
          error={fieldErrors['contactPerson']}
        />

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Address
          </legend>
          <Field
            label="Line 1"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            error={fieldErrors['addressLine1']}
          />
          <Field
            label="Line 2"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            error={fieldErrors['addressLine2']}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="City"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              error={fieldErrors['city']}
            />
            <Field
              label="Pincode"
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              error={fieldErrors['pincode']}
              inputMode="numeric"
            />
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Credit limit"
            value={String(creditLimit)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setCreditLimit(v);
            }}
            error={fieldErrors['creditLimit']}
            inputMode="decimal"
            hint="Warn past this on a new bill"
            className="tabular"
          />
          <Field
            label="Credit days"
            value={creditDays}
            onChange={(e) => setCreditDays(e.target.value.replace(/\D/g, ''))}
            error={fieldErrors['creditDays']}
            inputMode="numeric"
            hint="How long they get to pay"
            className="tabular"
          />
        </div>

        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={!isActive}
            onChange={(event) => setIsActive(!event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Inactive — hide from new bills
            </span>
            <span className="block text-xs text-slate-500">
              Their account and history stay untouched and still show in reports.
            </span>
          </span>
        </label>

        {!isActive && owesSomething ? (
          <Alert tone="warning">
            This account is not settled — {formatMoney(party.currentBalance)} is still outstanding.
            Making them inactive hides them from new bills but does not write the money off.
          </Alert>
        ) : null}

        <p className="text-xs text-slate-500">
          Opening balance ({formatMoney(party.openingBalance)}) cannot be edited here — the whole
          account is built on it. Correct it with an adjustment entry instead.
        </p>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
