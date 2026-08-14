import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Button } from '../components/Button';
import { Alert, ErrorAlert } from '../components/Alert';
import { Field } from '../components/Field';
import { AuthShell } from './AuthShell';

/**
 * Requesting a reset link.
 *
 * Two things this screen has to hold at once.
 *
 * The API answers identically whether or not the account exists, so this screen
 * must too — showing "no such user" would turn the endpoint into a way to find
 * out which phone numbers belong to real shops.
 *
 * But whether the *server* can send anything at all is not a fact about any
 * account, and saying so leaks nothing. A shop with no mail provider
 * configured — which is every shop until somebody sets one up, since SMS in
 * India needs DLT registration first — can deliver no link to anyone. Telling
 * that person "check your messages" leaves them refreshing an inbox for
 * something that was never sent. So when delivery is not configured, this says
 * so plainly and points at the path that does work: the owner setting the
 * password from Settings → Staff.
 */
export function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [canDeliver, setCanDeliver] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.post<{ deliveryConfigured?: boolean }>(
        '/api/auth/forgot-password',
        { identifier: identifier.trim() },
      );
      // Older servers do not send the flag; assume they can, which is the
      // previous behaviour rather than a false alarm.
      setCanDeliver(result.deliveryConfigured !== false);
      setSent(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent && !canDeliver) {
    return (
      <AuthShell title="No link can be sent">
        <div className="space-y-4">
          <Alert tone="warning">
            This shop has no email or SMS delivery set up, so nothing has been sent to{' '}
            <strong>{identifier}</strong> — and nothing will be.
          </Alert>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Ask the shop owner to set you a new password: <strong>Settings → Staff</strong>, then
            <strong> Set password</strong>. It takes a few seconds and works today.
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            If <em>you</em> are the owner, nobody can do this for you — whoever looks after the
            server can run <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">npm run set-password</code>{' '}
            against the database.
          </p>
          <Link to="/login">
            <Button variant="secondary" className="w-full">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (sent) {
    return (
      <AuthShell title="Check your messages">
        <div className="space-y-4">
          <Alert tone="success">
            If an account exists for <strong>{identifier}</strong> <em>and</em> it has an email
            address on it, a reset link is on its way.
          </Alert>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The link expires shortly. If nothing arrives, check the number and try again — or ask
            the shop owner to reset it for you.
          </p>
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
    <AuthShell title="Forgot password" subtitle="We'll send a link to reset it.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={error} />

        <Field
          label="Phone or email"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          autoFocus
          required
          placeholder="9876543210"
        />

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          disabled={!identifier.trim()}
          className="w-full"
        >
          Send reset link
        </Button>

        <p className="text-center text-sm">
          <Link
            to="/login"
            className="text-slate-600 underline-offset-4 hover:underline dark:text-slate-400"
          >
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
