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
 * The API answers identically whether or not the account exists, so this screen
 * must too — showing "no such user" here would turn the endpoint into a way to
 * find out which phone numbers belong to real shops.
 */
export function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/api/auth/forgot-password', { identifier: identifier.trim() });
      setSent(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your messages">
        <div className="space-y-4">
          <Alert tone="success">
            If an account exists for <strong>{identifier}</strong>, a reset link is on its way.
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
