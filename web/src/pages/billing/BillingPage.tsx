import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { formatMoney, formatQuantity } from '../../lib/money';
import type {
  CreateInvoiceResponse,
  PartyListItem,
  PartyListResponse,
  PreviewResponse,
  ProductListItem,
  ProductListResponse,
} from '../../lib/types';
import { Combobox, type ComboboxHandle } from '../../components/Combobox';
import { Button } from '../../components/Button';
import { Alert, ErrorAlert } from '../../components/Alert';
import { useBillingDraft } from './useBillingDraft';
import { LineItemsTable } from './LineItemsTable';
import { TotalsPanel } from './TotalsPanel';
import { IssuedInvoiceDialog } from './IssuedInvoiceDialog';
import { NewCustomerDialog } from './NewCustomerDialog';

/**
 * The billing counter.
 *
 * The screen this software exists for — opened dozens of times a day while
 * everything else is opened a handful. Two things follow from that:
 *
 *  1. **It is driven from the keyboard.** Choosing a customer moves focus to
 *     the product box; choosing a product moves focus to its quantity. F9
 *     saves. The mouse is on the counter, not in anyone's hand.
 *
 *  2. **The browser computes no money.** Every figure shown comes from
 *     `POST /api/sales-invoices/preview`, the same code path that will produce
 *     the real invoice. A tax split calculated in the browser could disagree
 *     with the printed bill, and the printed bill is the legal document.
 */
export function BillingPage() {
  const queryClient = useQueryClient();
  const draft = useBillingDraft();

  const [partyQuery, setPartyQuery] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [issued, setIssued] = useState<CreateInvoiceResponse | null>(null);
  const [newCustomerName, setNewCustomerName] = useState<string | null>(null);

  const partyBox = useRef<ComboboxHandle>(null);
  const productBox = useRef<ComboboxHandle>(null);
  const lastQuantityRef = useRef<HTMLInputElement>(null);

  const debouncedParty = useDebounced(partyQuery);
  const debouncedProduct = useDebounced(productQuery);

  /// True from the first keystroke until that exact text has been searched.
  /// Covers the debounce window as well as the request, which `isFetching`
  /// alone does not — the query has not even started during the debounce.
  const partyPending = partyQuery.trim() !== debouncedParty.trim();
  const productPending = productQuery.trim() !== debouncedProduct.trim();

  // ---- Searches ----

  const parties = useQuery({
    queryKey: ['parties', 'search', debouncedParty],
    queryFn: () =>
      api.get<PartyListResponse>('/api/masters/parties', {
        query: { search: debouncedParty, pageSize: 8, isActive: true },
      }),
    enabled: debouncedParty.trim().length > 0,
  });

  const products = useQuery({
    queryKey: ['products', 'search', debouncedProduct],
    queryFn: () =>
      api.get<ProductListResponse>('/api/masters/products', {
        query: { search: debouncedProduct, pageSize: 8, isActive: true },
      }),
    enabled: debouncedProduct.trim().length > 0,
  });

  // ---- Live pricing ----

  // Keyed on the request body, so it re-runs whenever anything priceable
  // changes and is served from cache when the user undoes an edit.
  const previewBody = draft.canPreview ? draft.toRequest() : null;

  const preview = useQuery({
    queryKey: ['invoice-preview', previewBody],
    queryFn: () => api.post<PreviewResponse>('/api/sales-invoices/preview', previewBody),
    enabled: Boolean(previewBody),
    // Prices and tax rates don't change mid-bill; refetching would only make
    // the totals flicker while the operator is reading them.
    staleTime: 60_000,
    // Keeps the previous totals on screen while an edit is being priced,
    // instead of blanking them on every keystroke.
    placeholderData: (previous) => previous,
  });

  /**
   * The priced bill, but only while there is a bill.
   *
   * `placeholderData` above keeps the last result even after the query is
   * disabled, which is right mid-edit and wrong once the bill is issued and
   * the form cleared — the totals panel went on showing ₹2,832 next to an empty
   * form, which is exactly the sort of thing that gets a customer charged for
   * the previous customer's goods.
   */
  const priced = previewBody ? preview.data : undefined;

  // ---- Issue ----

  const issue = useMutation({
    mutationFn: () => api.post<CreateInvoiceResponse>('/api/sales-invoices', draft.toRequest()),
    onSuccess(result) {
      setIssued(result);
      draft.reset();
      setPartyQuery('');
      setProductQuery('');
      partyBox.current?.clear();
      productBox.current?.clear();
      // Stock, balances and the invoice list have all moved.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
    },
  });

  const readyToIssue = draft.canPreview && !preview.isError && !issue.isPending;

  useHotkey({ key: 'F9' }, () => readyToIssue && issue.mutate(), readyToIssue);
  useHotkey({ key: 'F2' }, () => partyBox.current?.focus());
  useHotkey({ key: 'F3' }, () => productBox.current?.focus());

  function chooseParty(party: PartyListItem) {
    draft.setParty(party);
    // Straight on to the goods — nobody picks a customer and then stops.
    setTimeout(() => productBox.current?.focus(), 0);
  }

  function chooseProduct(product: ProductListItem) {
    draft.addProduct(product);
    setProductQuery('');
    productBox.current?.clear();
    // The row does not exist until React commits, hence the deferral.
    setTimeout(() => lastQuantityRef.current?.select(), 0);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            New bill
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            <Kbd>F2</Kbd> customer · <Kbd>F3</Kbd> add item · <Kbd>F9</Kbd> save &amp; print
          </p>
        </div>

        {draft.lines.length > 0 ? (
          <Button variant="ghost" onClick={draft.reset}>
            Clear bill
          </Button>
        ) : null}
      </header>

      <ErrorAlert error={issue.error} />

      {priced?.warnings?.length ? (
        <Alert tone="warning" title="Worth checking">
          <ul className="list-inside list-disc space-y-0.5">
            {priced.warnings.map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          {/* ---- Customer ---- */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            {draft.party ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-slate-500">Billing to</p>
                  <p className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {draft.party.displayName}
                  </p>
                  <p className="font-mono text-xs text-slate-500">
                    {draft.party.gstin ?? 'Unregistered'} · {draft.party.stateName}
                  </p>
                  {Number(draft.party.currentBalance) > 0 ? (
                    <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                      Already owes {formatMoney(draft.party.currentBalance)}
                      {draft.party.overCreditLimit ? ' — over their credit limit' : null}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    draft.setParty(null);
                    setTimeout(() => partyBox.current?.focus(), 0);
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <Combobox<PartyListItem>
                ref={partyBox}
                label="Customer"
                placeholder="Name, phone or GSTIN…"
                autoFocus
                items={parties.data?.parties ?? []}
                loading={parties.isFetching}
                pending={partyPending || parties.isFetching}
                itemKey={(p) => p.id}
                itemLabel={(p) => p.displayName}
                onSearch={setPartyQuery}
                onSelect={chooseParty}
                onCreate={setNewCustomerName}
                createLabel={(q) => `Add "${q}" as a new customer`}
                renderItem={(p) => (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                        {p.displayName}
                      </p>
                      <p className="truncate font-mono text-xs text-slate-500">
                        {p.gstin ?? 'Unregistered'}
                        {p.phone ? ` · ${p.phone}` : ''}
                      </p>
                    </div>
                    {Number(p.currentBalance) > 0 ? (
                      <span className="tabular shrink-0 text-xs text-amber-600 dark:text-amber-400">
                        {formatMoney(p.currentBalance)} due
                      </span>
                    ) : null}
                  </div>
                )}
              />
            )}
          </section>

          {/* ---- Items ---- */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <Combobox<ProductListItem>
              ref={productBox}
              label="Add item"
              placeholder="Product name or SKU…"
              disabled={!draft.party}
              hint={!draft.party ? 'Pick a customer first' : undefined}
              items={products.data?.products ?? []}
              loading={products.isFetching}
              pending={productPending || products.isFetching}
              itemKey={(p) => p.id}
              itemLabel={() => ''}
              onSearch={setProductQuery}
              onSelect={chooseProduct}
              renderItem={(p) => (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {p.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      HSN {p.hsnCode?.code ?? '—'}
                      {p.defaultSaleRate ? ` · ${formatMoney(p.defaultSaleRate)}` : ''}
                    </p>
                  </div>
                  <span
                    className={[
                      'tabular shrink-0 text-xs',
                      Number(p.quantityOnHand) <= 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : p.lowStock
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-500',
                    ].join(' ')}
                  >
                    {formatQuantity(p.quantityOnHand)} {p.baseUnit?.symbol ?? ''}
                  </span>
                </div>
              )}
            />

            <div className="mt-4">
              <LineItemsTable
                lines={draft.lines}
                pricedLines={priced?.lines}
                onUpdate={draft.updateLine}
                onRemove={draft.removeLine}
                lastQuantityRef={lastQuantityRef}
                onQuantityEnter={() => productBox.current?.focus()}
              />
            </div>
          </section>
        </div>

        {/* ---- Totals ---- */}
        <TotalsPanel
          preview={priced}
          loading={preview.isFetching}
          error={preview.error}
          freight={draft.freight}
          onFreightChange={draft.setFreight}
          notes={draft.notes}
          onNotesChange={draft.setNotes}
          onIssue={() => issue.mutate()}
          issuing={issue.isPending}
          canIssue={readyToIssue}
        />
      </div>

      {issued ? (
        <IssuedInvoiceDialog
          result={issued}
          onClose={() => {
            setIssued(null);
            partyBox.current?.focus();
          }}
        />
      ) : null}

      {newCustomerName !== null ? (
        <NewCustomerDialog
          initialName={newCustomerName}
          onCancel={() => setNewCustomerName(null)}
          onCreated={(party) => {
            setNewCustomerName(null);
            chooseParty(party);
          }}
        />
      ) : null}
    </div>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
    {children}
  </kbd>
);

/// Re-exported so the error boundary can tell an ApiError from a crash.
export { ApiError };
