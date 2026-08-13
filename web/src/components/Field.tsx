import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from 'react';

/**
 * A labelled input that can show a server-side error.
 *
 * The API returns validation failures as `{ path, message }` pairs keyed by the
 * same names used here, so a 400 can be dropped straight onto the right inputs
 * rather than shown as one opaque banner. `aria-invalid` and `aria-describedby`
 * are wired up so a screen reader announces the problem too.
 */

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className = '', id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
        {props.required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </label>

      <input
        {...props}
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={[
          'w-full rounded-lg border px-3 py-2.5 text-slate-900 shadow-sm outline-none transition',
          'placeholder:text-slate-400',
          'focus:ring-2 focus:ring-offset-0',
          'dark:bg-slate-900 dark:text-slate-100',
          error
            ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200 dark:border-rose-500/60'
            : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200 dark:border-slate-700 dark:focus:ring-slate-700',
        ].join(' ')}
      />

      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
