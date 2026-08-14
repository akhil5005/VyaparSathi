import { useEffect, useState } from 'react';

/**
 * Moving through a list that is longer than one page.
 *
 * Every list asked the server for page one and rendered whatever came back,
 * with no way to reach page two. That is invisible and harmless in the first
 * month and quietly wrong by the first year: a shop with three hundred
 * invoices saw the most recent hundred and nothing said so. Worse, the headers
 * printed the server's `total`, so the products screen would announce "300
 * products" above a table of 100.
 *
 * Deliberately plain — previous, next, and a sentence saying where you are.
 * Numbered page links look tidier and are worse here: they need the total page
 * count rendered as a row of buttons, and at a counter the only questions are
 * "is there more" and "go back".
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  /// What the rows are, for the sentence: "1–25 of 312 invoices".
  noun = 'rows',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  // One page of results needs no controls, and a shop with nine customers
  // should never see paging furniture.
  if (total <= pageSize) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label={`${noun} pages`}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800"
    >
      <p className="text-sm text-slate-600 dark:text-slate-400">
        <span className="tabular">
          {first}–{last}
        </span>{' '}
        of <span className="tabular font-medium">{total}</span> {noun}
      </p>

      <div className="flex items-center gap-2">
        <PageButton onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </PageButton>
        <span className="px-1 text-sm text-slate-500">
          Page <span className="tabular">{page}</span> of{' '}
          <span className="tabular">{lastPage}</span>
        </span>
        <PageButton onClick={() => onPage(page + 1)} disabled={page >= lastPage}>
          Next
        </PageButton>
      </div>
    </nav>
  );
}

function PageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

/**
 * Page state that resets when the list beneath it changes.
 *
 * Searching while on page four and staying on page four shows an empty table
 * and looks like "no results" — the classic paging bug. Pass whatever the query
 * is filtered by and the page returns to one whenever any of it moves.
 */
export function usePage(resetWhen: unknown[] = []): [number, (page: number) => void] {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    // The dependency list is supplied by the caller by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetWhen);

  return [page, setPage];
}
