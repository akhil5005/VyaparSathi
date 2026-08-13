import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import type { UserRole } from '../lib/types';
import { FullPageSpinner } from '../components/Spinner';

/**
 * Route guards.
 *
 * Both of these are *convenience*, not security. Every one of these decisions
 * is enforced again on the server, which is the only place it counts — a guard
 * here just avoids showing someone a screen that would only fail on submit.
 */

export function RequireAuth() {
  const { user, initialising } = useAuth();
  const location = useLocation();

  // Until the mount-time refresh settles we genuinely do not know, and
  // redirecting now would throw a signed-in user out on every reload.
  if (initialising) return <FullPageSpinner label="Signing you in…" />;

  if (!user) {
    // `state.from` lets the login page send them back where they were headed.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

export function RequireRole({ allow }: { allow: UserRole[] }) {
  const { user, initialising } = useAuth();

  if (initialising) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;

  if (!allow.includes(user.role)) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          You don't have access to this
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Your account is set up as <strong>{roleLabel(user.role)}</strong>. Ask the owner if you
          need this.
        </p>
      </div>
    );
  }

  return <Outlet />;
}

export const roleLabel = (role: UserRole): string =>
  ({
    OWNER: 'Owner',
    MANAGER: 'Manager',
    BILLING_STAFF: 'Billing staff',
    ACCOUNTANT: 'Accountant',
    VIEWER: 'Viewer',
  })[role];
