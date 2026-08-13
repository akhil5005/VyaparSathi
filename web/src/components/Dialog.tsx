import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal built on the native `<dialog>` element.
 *
 * Using the platform's dialog rather than a div-with-a-backdrop gets focus
 * trapping, the top layer, inertness of the page behind, and Escape handling
 * from the browser — all things that are easy to implement badly by hand and
 * that matter when the screen is driven from the keyboard.
 */
/**
 * `wide` is for dialogs containing a table.
 *
 * The default is sized for a form read top to bottom. A line-item table needs
 * more: at the default width the purchase dialog pushed its landed-cost column
 * — the single most useful figure on the screen — off the right edge behind a
 * horizontal scrollbar nobody would think to drag.
 */
const WIDTHS = {
  default: 'max-w-lg',
  wide: 'max-w-4xl',
} as const;

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'default',
  /// Some dialogs report a finished action and must be dismissed deliberately.
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof WIDTHS;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // showModal() throws if it is already open, which StrictMode's double
    // effect would otherwise trigger.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Escape closes it natively; this keeps React's state in step.
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose, dismissible]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClick={(event) => {
        // The backdrop is part of the dialog element, so a click landing
        // directly on it (rather than on a child) means outside the panel.
        if (dismissible && event.target === ref.current) onClose();
      }}
      className={`m-auto w-full ${WIDTHS[size]} rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900`}
    >
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2
            id="dialog-title"
            className="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            {title}
          </h2>
          {dismissible ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>

        {children}

        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </dialog>
  );
}
