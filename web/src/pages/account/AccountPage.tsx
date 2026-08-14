import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../auth/AuthProvider';
import { roleLabel } from '../../auth/RequireAuth';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Alert, ErrorAlert } from '../../components/Alert';

/**
 * Your own account, and the one thing everybody eventually needs to do to it.
 *
 * Until this existed, a staff member was permanently stuck with whatever
 * password the owner typed for them when the account was created — which in a
 * shop means it stays written on a slip of paper by the till for years.
 *
 * The server treats a password change as a security event: it bumps
 * `tokenVersion` and revokes every session, including this one. That is
 * correct — if you are changing a password because it leaked, leaving the
 * leaked session alive defeats the point — but it means this screen has to
 * hand the user to the login page rather than pretend nothing happened.
 */
export function AccountPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>('/api/auth/change-password', {
        currentPassword,
        newPassword,
      }),
  });

  async function finish() {
    // The session is already dead server-side; this clears the client so the
    // login screen is reached deliberately rather than via a failed request.
    await signOut().catch(() => undefined);
    navigate('/login', { replace: true });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMismatch(null);

    if (newPassword !== confirmPassword) {
      setMismatch('The two new passwords do not match');
      return;
    }
    if (newPassword.length < 10) {
      setMismatch('Use at least 10 characters');
      return;
    }
    change.mutate();
  }

  const fieldErrors = change.error instanceof ApiError ? change.error.fieldErrors : {};

  if (change.isSuccess) {
    return (
      <div className="max-w-lg space-y-5">
        <Header />
        <Alert tone="success" title="Password changed">
          You have been signed out on every device, including this one. Sign in again with the new
          password.
        </Alert>
        <Button size="lg" onClick={finish}>
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <Header />
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Signed in as</h2>
        <p className="mt-1 text-slate-900 dark:text-slate-100">{user?.fullName}</p>
        <p className="text-sm text-slate-500">
          {[user ? roleLabel(user.role) : null, user?.phone, user?.email]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </section>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Change your password
        </h2>

        <ErrorAlert error={change.error} />
        {mismatch ? <Alert tone="error">{mismatch}</Alert> : null}

        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          error={fieldErrors['currentPassword']}
          required
        />

        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          error={fieldErrors['newPassword']}
          hint="At least 10 characters. A short phrase you can remember beats a short jumble you cannot."
          required
        />

        <Field
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />

        <Alert tone="info">
          Changing this signs you out everywhere — this device too. Have the new password to hand
          before you continue.
        </Alert>

        <Button
          type="submit"
          size="lg"
          loading={change.isPending}
          disabled={!currentPassword || !newPassword || !confirmPassword}
        >
          Change password
        </Button>
      </form>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        My account
      </h1>
      <p className="mt-1 text-sm text-slate-500">Your own login, and how to change it.</p>
    </header>
  );
}
