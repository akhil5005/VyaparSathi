import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../auth/AuthProvider';
import { roleLabel } from '../../auth/RequireAuth';
import type { User } from '../../lib/types';
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

      <ContactDetails />

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

/**
 * Your name and email.
 *
 * The email is not decoration — it is the only channel a password reset can
 * currently reach, because SMS in India needs DLT registration before a single
 * message can be sent. An account with no email address cannot be reset at all.
 *
 * For staff that is inconvenient: the owner sets them a new password from
 * Settings → Staff. For the **owner** it is a trap, because nobody can do that
 * for the owner — a forgotten password with no email on the account means the
 * shop is locked out of its own books until somebody goes to the database. So
 * an owner without one is told, here, in as many words.
 */
function ContactDetails() {
  const { user, reload } = useAuth();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ user: User }>('/api/auth/me', {
        fullName: fullName.trim(),
        // Explicitly null when blank — omitting it would mean "leave it", and
        // clearing an address would silently do nothing.
        email: email.trim() || null,
      }),
    async onSuccess() {
      setSaved(true);
      await reload();
    },
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const changed = fullName.trim() !== (user?.fullName ?? '') || email.trim() !== (user?.email ?? '');
  const noEmail = !user?.email;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (changed && fullName.trim().length >= 2) save.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Your details</h2>

      <ErrorAlert error={save.error} />
      {saved && !changed ? <Alert tone="success">Saved.</Alert> : null}

      {noEmail ? (
        <Alert tone="warning" title="No email on this account">
          {user?.role === 'OWNER'
            ? 'You cannot reset your own password without one, and nobody else can reset the owner. Add an email now, while you still know the password.'
            : 'Password reset cannot reach you without one. Until then, ask the owner to set you a new password from Settings → Staff.'}
        </Alert>
      ) : null}

      <Field
        label="Full name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        error={fieldErrors['fullName']}
        required
      />

      <Field
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors['email']}
        hint="Where a password reset link would be sent"
        placeholder="you@example.com"
      />

      <p className="text-xs text-slate-500">
        Your phone number ({user?.phone}) and your role are the owner's to change, from
        Settings → Staff.
      </p>

      <Button
        type="submit"
        variant="secondary"
        loading={save.isPending}
        disabled={!changed || fullName.trim().length < 2}
      >
        Save details
      </Button>
    </form>
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
