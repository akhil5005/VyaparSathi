import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/Button';
import { Alert, ErrorAlert } from '../components/Alert';
import { Field } from '../components/Field';
import { AuthShell } from './AuthShell';

/**
 * Why a reset link failed, said properly.
 *
 * All four of these used to render as "This reset link is invalid or has
 * expired", which tells the reader nothing about what to do next — open a
 * different email, ask for a new link, or stop because the password already
 * changed. The unrecognised case is the one that cost real time: it is also
 * what a link pointing at the wrong deployment produces, and the shared
 * wording hid that completely.
 */
const REASONS: Record<string, { title: string; body: ReactNode; askAgain: boolean }> = {
  RESET_TOKEN_SUPERSEDED: {
    title: 'A newer link replaced this one',
    body: (
      <>
        You asked for another reset link after this email was sent, and asking again retires the
        previous link. <strong>Open the most recent email</strong> — it is the only one that works.
      </>
    ),
    askAgain: false,
  },
  RESET_TOKEN_EXPIRED: {
    title: 'This link has expired',
    body: 'Reset links last 30 minutes. Ask for a new one and use it straight away.',
    askAgain: true,
  },
  RESET_TOKEN_USED: {
    title: 'This link has already been used',
    body: 'The password was changed with it. Sign in with the new password — or if that was not you, ask for another link.',
    askAgain: true,
  },
  RESET_TOKEN_UNKNOWN: {
    title: 'This link is not recognised',
    body: (
      <>
        Two things usually cause this. Your mail app may have cut the link short — try copying the
        whole thing into the address bar. Or the link points at a different address than the one you
        normally use; check it begins with the same web address you sign in at.
      </>
    ),
    askAgain: true,
  },
};

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const matches = confirm.length === 0 || password === confirm;
  const ready = token && password.length >= 10 && password === confirm;

  /// A dead link is a dead end — replace the form rather than sit under it.
  const reason = error instanceof ApiError ? REASONS[error.code] : undefined;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;

    setError(null);
    setSubmitting(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: password });
      // Resetting invalidates every existing session, so there is nothing to
      // resume — send them to sign in with the new password.
      navigate('/login', { replace: true, state: { justReset: true } });
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Reset password">
        <div className="space-y-4">
          <Alert tone="error">
            This link is missing its token. Request a new one — reset links can only be used once.
          </Alert>
          <Link to="/forgot-password">
            <Button className="w-full">Request a new link</Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (reason) {
    return (
      <AuthShell title="Reset password">
        <div className="space-y-4">
          <Alert tone="warning" title={reason.title}>
            {reason.body}
          </Alert>
          {reason.askAgain ? (
            <Link to="/forgot-password">
              <Button className="w-full">Request a new link</Button>
            </Link>
          ) : null}
          <Link to="/login">
            <Button variant="secondary" className="w-full">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password" subtitle="This signs you out everywhere else.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={error} />

        <Field
          label="New password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={
            password.length > 0 && password.length < 10
              ? `${10 - password.length} more characters needed`
              : 'At least 10 characters'
          }
          autoComplete="new-password"
          autoFocus
          required
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={matches ? undefined : "Passwords don't match"}
          autoComplete="new-password"
          required
        />

        <Button type="submit" size="lg" loading={submitting} disabled={!ready} className="w-full">
          Set password
        </Button>
      </form>
    </AuthShell>
  );
}
