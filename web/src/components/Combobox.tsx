import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Spinner } from './Spinner';

/**
 * A search-as-you-type picker.
 *
 * Written rather than pulled from a library because the requirement is
 * specific: at a billing counter this is driven entirely from the keyboard, and
 * the arrow/Enter/Escape behaviour has to be exactly right or it slows the
 * operator down instead of helping.
 *
 * Follows the ARIA combobox pattern — `role="combobox"` on the input,
 * `aria-activedescendant` pointing at the highlighted option — so the
 * highlighted row is announced without focus ever leaving the text field.
 */

export interface ComboboxHandle {
  focus: () => void;
  clear: () => void;
}

interface ComboboxProps<T> {
  label: string;
  placeholder?: string;
  items: T[];
  loading?: boolean;
  /// Stable key per item.
  itemKey: (item: T) => string;
  /// What goes in the input once chosen.
  itemLabel: (item: T) => string;
  /// The row in the dropdown. Gets more room than the label.
  renderItem: (item: T) => ReactNode;
  /**
   * True while the typed text has not been searched yet — debounce still
   * running, or the request in flight.
   *
   * Without this, Enter pressed straight after typing fires the "create"
   * action: the results have not arrived, so `items` is empty, and the
   * highlighted index 0 *is* the create row. At a counter, where the operator
   * types a name and hits Enter in one motion, that means a duplicate customer
   * every time instead of a match. While pending, Enter does nothing.
   */
  pending?: boolean;
  onSearch: (query: string) => void;
  onSelect: (item: T) => void;
  /// Offered when nothing matches — "Add «Sharma Stationery» as a new customer".
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: ReactNode;
}

function ComboboxInner<T>(
  {
    label,
    placeholder,
    items,
    loading = false,
    pending = false,
    itemKey,
    itemLabel,
    renderItem,
    onSearch,
    onSelect,
    onCreate,
    createLabel,
    disabled,
    autoFocus,
    hint,
  }: ComboboxProps<T>,
  ref: React.Ref<ComboboxHandle>,
) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: () => {
      setQuery('');
      setOpen(false);
      onSearch('');
    },
  }));

  // The "create" row sits one past the end of the list. Hidden while the
  // search is unsettled, so it can neither be highlighted nor clicked before
  // the operator has seen whether the thing already exists.
  const canCreate = Boolean(onCreate) && query.trim().length > 1 && !pending;
  const optionCount = items.length + (canCreate ? 1 : 0);
  const creating = canCreate && highlight === items.length;

  /**
   * Whether the operator has deliberately moved the highlight with the arrows.
   *
   * This is what stands between a fast typist and a database full of duplicate
   * customers. With an empty result list the default highlight of 0 *is* the
   * create row, so "type a name, hit Enter" — the natural motion at a counter —
   * would silently offer to create a customer that already exists, purely
   * because the search had not come back yet. Guarding on the search being
   * settled helps but cannot close the race; requiring deliberate intent does.
   *
   * So: Enter only ever selects an existing match. Creating something new needs
   * an arrow key or a click, which nobody does by accident.
   */
  const [arrowed, setArrowed] = useState(false);

  // A changed result set invalidates the old highlight index, and any intent
  // the operator had expressed about the previous list.
  useEffect(() => {
    setHighlight(0);
    setArrowed(false);
  }, [items]);

  // Keep the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  // Clicking away closes it. Blur alone is unreliable here because clicking an
  // option blurs the input before the click registers.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(index: number) {
    if (canCreate && index === items.length) {
      onCreate?.(query.trim());
    } else {
      const item = items[index];
      if (!item) return;
      onSelect(item);
      setQuery(itemLabel(item));
    }
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setArrowed(true);
        if (!open) setOpen(true);
        else setHighlight((h) => (h + 1) % Math.max(1, optionCount));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setArrowed(true);
        setHighlight((h) => (h - 1 + Math.max(1, optionCount)) % Math.max(1, optionCount));
        break;
      case 'Enter': {
        if (!open) break; // Let it submit the form.
        // Acting on an unsettled search would pick from a list that is about to
        // change under the operator.
        if (pending) {
          event.preventDefault();
          break;
        }
        /**
         * Enter never creates unless the operator arrowed onto that row.
         *
         * The highlight also moves on hover, which is conventional but means
         * the mouse merely resting where the dropdown happens to open can land
         * it on "add new" — and after clicking the search box, that is exactly
         * where the pointer is. Enter would then offer to create a customer
         * who is sitting right there in the list.
         *
         * So a create that was not asked for falls back to the best match
         * instead. Doing nothing would be safe but baffling; picking the top
         * result is what the operator meant.
         */
        const wouldCreate = canCreate && highlight === items.length;
        if (wouldCreate && !arrowed) {
          event.preventDefault();
          if (items.length > 0) choose(0);
          break;
        }
        if (optionCount > 0) {
          event.preventDefault();
          choose(highlight);
        }
        break;
      }
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label
        htmlFor={`${listId}-input`}
        className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
      </label>

      <div className="relative">
        <input
          id={`${listId}-input`}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && optionCount ? `${listId}-opt-${highlight}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onSearch(event.target.value);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 pr-9 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
        />
        {loading ? (
          <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        ) : null}
      </div>

      {hint ? <p className="mt-1.5 text-sm text-slate-500">{hint}</p> : null}

      {open ? (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {items.map((item, index) => (
            <li
              key={itemKey(item)}
              id={`${listId}-opt-${index}`}
              data-index={index}
              role="option"
              aria-selected={highlight === index}
              // pointerdown, not click: click fires after blur, by which time
              // the list has closed and the selection is lost.
              onPointerDown={(event) => {
                event.preventDefault();
                choose(index);
              }}
              onPointerEnter={() => setHighlight(index)}
              className={[
                'cursor-pointer px-3 py-2 text-sm',
                highlight === index
                  ? 'bg-slate-100 dark:bg-slate-800'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
              ].join(' ')}
            >
              {renderItem(item)}
            </li>
          ))}

          {canCreate ? (
            <li
              id={`${listId}-opt-${items.length}`}
              data-index={items.length}
              role="option"
              aria-selected={creating}
              onPointerDown={(event) => {
                event.preventDefault();
                choose(items.length);
              }}
              onPointerEnter={() => setHighlight(items.length)}
              className={[
                'cursor-pointer border-t border-slate-100 px-3 py-2 text-sm font-medium dark:border-slate-800',
                creating ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
              ].join(' ')}
            >
              {createLabel?.(query.trim()) ?? `Add "${query.trim()}"`}
            </li>
          ) : null}

          {pending && items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-slate-500">Searching…</li>
          ) : !loading && items.length === 0 && !canCreate ? (
            <li className="px-3 py-6 text-center text-sm text-slate-500">
              {query ? 'Nothing found' : 'Start typing to search'}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/// `forwardRef` erases the generic, so it is restored on the way out.
export const Combobox = forwardRef(ComboboxInner) as <T>(
  props: ComboboxProps<T> & { ref?: React.Ref<ComboboxHandle> },
) => ReturnType<typeof ComboboxInner>;
