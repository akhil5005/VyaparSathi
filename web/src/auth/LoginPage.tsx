import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { ApiError } from '../lib/api';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/Alert';
import { Field } from '../components/Field';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  const { signIn, user, initialising } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone who is already signed in has no business on the login screen —
  // send them where they were headed, or to the dashboard.
  const destination = (location.state as { from?: Location } | null)?.from?.pathname ?? '/';
  if (!initialising && user) return <Navigate to={destination} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(identifier, password);
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(cause);
      // Keep the identifier — retyping a phone number after one typo in the
      // password is a small, avoidable irritation.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  const rateLimited = error instanceof ApiError && error.status === 429;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Enter the phone number or email registered with the shop."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={error} />

        <Field
          label="Phone or email"
          name="identifier"
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          // A 10-digit mobile is the common case, so bring up the number pad on
          // a phone — but not type="tel", since an email is equally valid.
          inputMode="text"
          autoComplete="username"
          autoFocus
          required
          placeholder="9876543210"
        />

        <div>
          <Field
            label="Password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <label className="mt-2 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(e) => setShowPassword(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Show password
          </label>
        </div>

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          disabled={!identifier.trim() || !password || rateLimited}
          className="w-full"
        >
          Sign in
        </Button>

        <div className="flex items-center justify-between pt-1 text-sm">
          <Link
            to="/forgot-password"
            className="text-slate-600 underline-offset-4 hover:underline dark:text-slate-400"
          >
            Forgot password?
          </Link>
          <Link
            to="/signup"
            className="font-medium text-slate-900 underline-offset-4 hover:underline dark:text-slate-100"
          >
            Register a new shop
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
