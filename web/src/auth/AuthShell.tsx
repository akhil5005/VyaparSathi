import type { ReactNode } from 'react';

/**
 * The frame around every signed-out screen.
 *
 * Deliberately plain. A shopkeeper signing in at 8am on a counter PC wants one
 * obvious thing to do, not a marketing page.
 */
export function AuthShell({
  title,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: string;
  /// Registration collects a whole business, so it gets more room.
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className={wide ? 'w-full max-w-2xl' : 'w-full max-w-sm'}>
          <div className="mb-8 text-center">
            <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white dark:bg-slate-100 dark:text-slate-900">
              G
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            {children}
          </div>

          <p className="mt-6 text-center text-xs text-slate-400">
            GSTCal — GST billing, inventory and ledger
          </p>
        </div>
      </main>
    </div>
  );
}
