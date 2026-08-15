import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from './ErrorBoundary';
import { AskDialog } from './AskDialog';
import { api } from '../lib/api';
import type { AiStatus } from '../lib/types';
import {
  CAN_EDIT_MASTERS,
  CAN_FILE_RETURNS,
  CAN_RECEIVE_PAYMENT,
  useAuth,
} from '../auth/AuthProvider';
import { roleLabel } from '../auth/RequireAuth';
import type { UserRole } from '../lib/types';
import { Button } from './Button';

interface NavItem {
  to: string;
  label: string;
  /// Omitted means everyone signed in can see it.
  allow?: UserRole[];
  end?: boolean;
}

/**
 * Billing sits at the top because it is the reason the software exists — at a
 * counter it is opened dozens of times a day and everything else a handful.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/billing', label: 'New bill' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/parties', label: 'Customers & suppliers' },
  { to: '/products', label: 'Products & stock' },
  { to: '/credit-notes', label: 'Credit notes', allow: CAN_EDIT_MASTERS },
  { to: '/purchases', label: 'Purchases', allow: CAN_EDIT_MASTERS },
  { to: '/payments', label: 'Payments & udhaar', allow: CAN_RECEIVE_PAYMENT },
  { to: '/gstr1', label: 'GST returns', allow: CAN_FILE_RETURNS },
  { to: '/settings', label: 'Settings', allow: CAN_EDIT_MASTERS },
  { to: '/account', label: 'My account' },
];

export function Layout() {
  const { user, business, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  const visible = NAV.filter((item) => !item.allow || (user && item.allow.includes(user.role)));

  const ai = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api.get<AiStatus>('/api/ai/status'),
    // A deployment does not gain an API key mid-session.
    staleTime: Infinity,
  });

  async function onSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Skip link — this app is driven from the keyboard at a counter. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-900 dark:text-slate-100">
              {business?.tradeName || business?.legalName || 'Vyapar Sathi'}
            </p>
            {business ? (
              <p className="truncate font-mono text-xs text-slate-500">{business.gstin}</p>
            ) : null}
          </div>

          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {user?.fullName}
            </p>
            <p className="text-xs text-slate-500">{user ? roleLabel(user.role) : null}</p>
          </div>

          {/* Sits in the header rather than on a page because the question
              gets asked wherever you happen to be standing. Hidden entirely
              when the deployment has no AI key — an always-failing button is
              worse than no button. */}
          {ai.data?.available ? (
            <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
              Ask
            </Button>
          ) : null}

          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      {asking ? (
        <AskDialog onClose={() => setAsking(false)} speech={ai.data?.speech ?? false} />
      ) : null}

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        <nav
          className={[
            'w-60 shrink-0 lg:block',
            menuOpen ? 'block' : 'hidden',
          ].join(' ')}
          aria-label="Main"
        >
          <ul className="space-y-1">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    [
                      'block rounded-lg px-3 py-2.5 text-sm font-medium transition',
                      isActive
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'text-slate-700 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-800',
                    ].join(' ')
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main" className="min-w-0 flex-1">
          {/* Scoped to the content, not the whole page: a crashed screen still
              leaves the nav usable, so the operator can walk away from it. The
              route path resets the boundary on navigation. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
