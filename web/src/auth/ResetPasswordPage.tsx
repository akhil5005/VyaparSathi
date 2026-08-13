import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Button } from '../components/Button';
import { Alert, ErrorAlert } from '../components/Alert';
import { Field } from '../components/Field';
import { AuthShell } from './AuthShell';

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
