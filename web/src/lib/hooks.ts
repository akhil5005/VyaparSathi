import { useEffect, useRef, useState } from 'react';

/**
 * Holds a value back until it stops changing.
 *
 * Used for the type-ahead searches and the live invoice preview. The preview in
 * particular hits a real endpoint that resolves products, looks up tax rates
 * and computes totals — firing it on every keystroke of a quantity field would
 * be both wasteful and visibly jumpy.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Fires a callback on a keyboard shortcut, anywhere on the page.
 *
 * Billing is a keyboard job — the mouse is on the counter, not in anyone's
 * hand. Shortcuts are ignored while focus is inside a text input unless the
 * combination includes a modifier, so typing "F9 reams" into a product name
 * doesn't save the bill.
 */
export function useHotkey(
  combo: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean },
  handler: () => void,
  enabled = true,
) {
  const saved = useRef(handler);
  saved.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== combo.key.toLowerCase()) return;
      if (!!combo.ctrl !== (event.ctrlKey || event.metaKey)) return;
      if (!!combo.alt !== event.altKey) return;
      if (combo.shift !== undefined && combo.shift !== event.shiftKey) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      // A bare letter key must never steal a keystroke from an input. Function
      // keys and modified combos are safe because nothing types them.
      const isBareLetter = !combo.ctrl && !combo.alt && combo.key.length === 1;
      if (typing && isBareLetter) return;

      event.preventDefault();
      saved.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo.key, combo.ctrl, combo.alt, combo.shift, enabled]);
}

/// Focuses an element once, after it appears. Returns the ref to attach.
export function useAutoFocus<T extends HTMLElement>(when = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);
  return ref;
}
