import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { ApiError } from '../lib/api';
import { validateGstin } from '../lib/gstin';
import { Button } from '../components/Button';
import { Alert, ErrorAlert } from '../components/Alert';
import { Field } from '../components/Field';
import { AuthShell } from './AuthShell';

/**
 * Registering a shop.
 *
 * One server call creates the business, the owner, the default unit master and
 * the invoice number sequences in a single transaction — so this form either
 * fully succeeds or leaves nothing behind. It is split into two visual steps
 * because eleven inputs at once reads as a wall, not because the submit is
 * staged.
 */

const EMPTY = {
  legalName: '',
  tradeName: '',
  gstin: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  pincode: '',
  businessPhone: '',
  businessEmail: '',
  fullName: '',
  ownerPhone: '',
  ownerEmail: '',
  password: '',
  confirmPassword: '',
};

export function SignupPage() {
  const { signUp, user, initialising } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  if (!initialising && user) return <Navigate to="/" replace />;

  // Checked as they type, so a mistyped check digit is caught before submit.
  const gstinCheck = useMemo(
    () => (form.gstin.trim() ? validateGstin(form.gstin) : null),
    [form.gstin],
  );

  const serverFields = error instanceof ApiError ? error.fieldErrors : {};

  /// The API returns dotted paths ("business.gstin"); match either form.
  const fieldError = (...paths: string[]): string | undefined =>
    paths.map((path) => serverFields[path]).find(Boolean);

  const passwordsMatch =
    form.confirmPassword.length === 0 || form.password === form.confirmPassword;

  const stepOneComplete =
    form.legalName.trim().length >= 2 &&
    gstinCheck?.valid === true &&
    form.addressLine1.trim().length >= 3 &&
    form.city.trim().length >= 2 &&
    /^\d{6}$/.test(form.pincode) &&
    /^[6-9]\d{9}$/.test(form.businessPhone.replace(/\D/g, '').slice(-10));

  const stepTwoComplete =
    form.fullName.trim().length >= 2 &&
    /^[6-9]\d{9}$/.test(form.ownerPhone.replace(/\D/g, '').slice(-10)) &&
    form.password.length >= 10 &&
    form.password === form.confirmPassword;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!stepTwoComplete) return;

    setError(null);
    setSubmitting(true);
    try {
      await signUp({
        business: {
          legalName: form.legalName.trim(),
          ...(form.tradeName.trim() ? { tradeName: form.tradeName.trim() } : {}),
          gstin: form.gstin.trim().toUpperCase(),
          addressLine1: form.addressLine1.trim(),
          ...(form.addressLine2.trim() ? { addressLine2: form.addressLine2.trim() } : {}),
          city: form.city.trim(),
          pincode: form.pincode.trim(),
          phone: form.businessPhone.trim(),
          ...(form.businessEmail.trim() ? { email: form.businessEmail.trim() } : {}),
        },
        owner: {
          fullName: form.fullName.trim(),
          ...(form.ownerEmail.trim() ? { email: form.ownerEmail.trim() } : {}),
          phone: form.ownerPhone.trim(),
          password: form.password,
        },
      });
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause);
      // A rejected field is almost always on step 1 (GSTIN, phone), so go back
      // rather than leaving the user staring at a step-2 form with no visible
      // problem on it.
      if (cause instanceof ApiError) {
        const hasBusinessError = Object.keys(cause.fieldErrors).some((k) =>
          k.startsWith('business'),
        );
        if (hasBusinessError) setStep(1);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      wide
      title="Register your shop"
      subtitle="This creates the firm, your owner account, the unit master and the invoice numbering."
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Stepper step={step} />

        <ErrorAlert error={error} />

        {step === 1 ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Legal name"
                value={form.legalName}
                onChange={set('legalName')}
                error={fieldError('business.legalName')}
                hint="Exactly as registered with GST"
                required
                autoFocus
                placeholder="Mittal Paper Traders"
              />
              <Field
                label="Trade name"
                value={form.tradeName}
                onChange={set('tradeName')}
                error={fieldError('business.tradeName')}
                hint="The name on the board, if different"
                placeholder="Mittal Paper House"
              />
            </div>

            <Field
              label="GSTIN"
              value={form.gstin}
              onChange={(e) =>
                setForm((p) => ({ ...p, gstin: e.target.value.toUpperCase().slice(0, 15) }))
              }
              error={
                fieldError('business.gstin') ??
                (form.gstin.length === 15 && !gstinCheck?.valid ? gstinCheck?.reason : undefined)
              }
              hint={
                gstinCheck?.valid ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    ✓ Valid — {gstinCheck.stateName}
                  </span>
                ) : (
                  `${form.gstin.length}/15 characters`
                )
              }
              required
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              placeholder="03AABCM1234C1ZX"
            />

            <Field
              label="Address"
              value={form.addressLine1}
              onChange={set('addressLine1')}
              error={fieldError('business.addressLine1')}
              required
              placeholder="Shop 14, Paper Market"
            />
            <Field
              label="Address line 2"
              value={form.addressLine2}
              onChange={set('addressLine2')}
              error={fieldError('business.addressLine2')}
              placeholder="Gill Road"
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="City"
                value={form.city}
                onChange={set('city')}
                error={fieldError('business.city')}
                required
                placeholder="Ludhiana"
              />
              <Field
                label="Pincode"
                value={form.pincode}
                onChange={(e) =>
                  setForm((p) => ({ ...p, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) }))
                }
                error={fieldError('business.pincode')}
                inputMode="numeric"
                required
                placeholder="141008"
              />
              <Field
                label="Shop phone"
                value={form.businessPhone}
                onChange={set('businessPhone')}
                error={fieldError('business.phone')}
                inputMode="tel"
                required
                placeholder="9876543210"
              />
            </div>

            <Field
              label="Shop email"
              type="email"
              value={form.businessEmail}
              onChange={set('businessEmail')}
              error={fieldError('business.email')}
              hint="Optional — printed on the invoice"
              placeholder="sales@example.com"
            />

            <div className="flex justify-end pt-1">
              <Button type="button" size="lg" disabled={!stepOneComplete} onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <Field
              label="Your name"
              value={form.fullName}
              onChange={set('fullName')}
              error={fieldError('owner.fullName')}
              required
              autoFocus
              placeholder="Akhil Mittal"
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Your phone"
                value={form.ownerPhone}
                onChange={set('ownerPhone')}
                error={fieldError('owner.phone')}
                hint="You'll sign in with this"
                inputMode="tel"
                autoComplete="tel"
                required
                placeholder="9876543210"
              />
              <Field
                label="Your email"
                type="email"
                value={form.ownerEmail}
                onChange={set('ownerEmail')}
                error={fieldError('owner.email')}
                hint="Optional — also works for signing in"
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Password"
                type="password"
                value={form.password}
                onChange={set('password')}
                error={fieldError('owner.password')}
                hint={
                  form.password.length > 0 && form.password.length < 10
                    ? `${10 - form.password.length} more characters needed`
                    : 'At least 10 characters'
                }
                autoComplete="new-password"
                required
              />
              <Field
                label="Confirm password"
                type="password"
                value={form.confirmPassword}
                onChange={set('confirmPassword')}
                error={passwordsMatch ? undefined : "Passwords don't match"}
                autoComplete="new-password"
                required
              />
            </div>

            <Alert tone="info">
              A long phrase you'll remember beats a short one with symbols. This account is the
              owner — it can add staff with limited access later.
            </Alert>

            <div className="flex items-center justify-between pt-1">
              <Button type="button" variant="secondary" size="lg" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" size="lg" loading={submitting} disabled={!stepTwoComplete}>
                Create shop
              </Button>
            </div>
          </>
        )}

        <p className="border-t border-slate-200 pt-4 text-center text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
          Already registered?{' '}
          <Link
            to="/login"
            className="font-medium text-slate-900 underline-offset-4 hover:underline dark:text-slate-100"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

function Stepper({ step }: { step: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-3 text-sm" aria-label="Progress">
      {(
        [
          [1, 'Shop details'],
          [2, 'Your account'],
        ] as const
      ).map(([number, label], index) => (
        <li key={number} className="flex items-center gap-3">
          {index > 0 ? <span className="h-px w-6 bg-slate-300 dark:bg-slate-700" /> : null}
          <span
            className={
              step === number
                ? 'font-medium text-slate-900 dark:text-slate-100'
                : 'text-slate-400 dark:text-slate-600'
            }
            aria-current={step === number ? 'step' : undefined}
          >
            <span
              className={[
                'mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-xs',
                step >= number
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-slate-200 text-slate-500 dark:bg-slate-800',
              ].join(' ')}
            >
              {number}
            </span>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
