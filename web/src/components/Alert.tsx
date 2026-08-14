import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

type Tone = 'error' | 'warning' | 'info' | 'success';

const TONES: Record<Tone, string> = {
  error:
    'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200',
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200',
};

export function Alert({
  tone = 'error',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      // assertive for errors: the user just pressed a button and needs to know
      // it failed, rather than discovering it whenever focus happens to land.
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-4 py-3 text-sm ${TONES[tone]}`}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  );
}

/**
 * Renders whatever was thrown.
 *
 * Field-level validation errors are shown on the inputs themselves, so this
 * deliberately says something short rather than repeating them — otherwise a
 * bad GSTIN is reported twice in two different places.
 */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;

  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR' && error.fields?.length) {
      return <Alert tone="error">Some fields need correcting — see below.</Alert>;
    }
    /**
     * "Please try again" is added only where the server did not already say
     * when to come back. A 429 always names its own wait — appending to it
     * produced "Too many reset requests. Try again later. Please try again.",
     * which reads like a stutter and tells the reader nothing new.
     */
    const alreadySaysRetry = error.status === 429 || /try again/i.test(error.message);

    return (
      <Alert tone="error">
        {error.message}
        {error.isTransient && !alreadySaysRetry ? ' Please try again.' : null}
      </Alert>
    );
  }

  return <Alert tone="error">Something went wrong. Please try again.</Alert>;
}
