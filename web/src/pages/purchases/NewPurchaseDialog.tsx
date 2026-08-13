import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatMoney, formatQuantity } from '../../lib/money';
import type {
  PartyListItem,
  PartyListResponse,
  ProductDetail,
  ProductListResponse,
  PurchasePreviewResponse,
} from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Combobox, type ComboboxHandle } from '../../components/Combobox';
import { usePurchaseDraft } from './usePurchaseDraft';
import { PurchaseLinesTable } from './PurchaseLinesTable';

/**
 * Entering a supplier bill.
 *
 * Typed exactly as printed — the mill's own invoice number and date, its
 * quantities in its units, its rates. The server converts kilograms to reams,
 * spreads freight across the lines and works out the landed cost. Re-keying it
 * into shop units by hand is how cost bases drift.
 *
 * Typing the bill's grand total is optional but worth it: the server compares
 * and flags a mismatch here, rather than the difference surfacing months later
 * during a GSTR-2B reconciliation.
 */
export function NewPurchaseDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const draft = usePurchaseDraft();

  const [supplierQuery, setSupplierQuery] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const supplierBox = useRef<ComboboxHandle>(null);
  const productBox = useRef<ComboboxHandle>(null);

  const debouncedSupplier = useDebounced(supplierQuery);
  const debouncedProduct = useDebounced(productQuery);
  const supplierPending = supplierQuery.trim() !== debouncedSupplier.trim();
  const productPending = productQuery.trim() !== debouncedProduct.trim();

  const suppliers = useQuery({
    queryKey: ['parties', 'search', debouncedSupplier, 'supplier'],
    queryFn: () =>
      api.get<PartyListResponse>('/api/masters/parties', {
        query: { search: debouncedSupplier, pageSize: 8, isActive: true },
      }),
    enabled: debouncedSupplier.trim().length > 0,
  });

  const products = useQuery({
    queryKey: ['products', 'search', debouncedProduct],
    queryFn: () =>
      api.get<ProductListResponse>('/api/masters/products', {
        query: { search: debouncedProduct, pageSize: 8, isActive: true },
      }),
    enabled: debouncedProduct.trim().length > 0,
  });

  const previewBody = draft.canPreview ? draft.toRequest() : null;

  const preview = useQuery({
    queryKey: ['purchase-preview', previewBody],
    queryFn: () => api.post<PurchasePreviewResponse>('/api/purchases/preview', previewBody),
    enabled: Boolean(previewBody),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  // Same trap as the sales screen: placeholderData outlives the query being
  // disabled, so it is gated on there actually being a bill.
  const priced = previewBody ? preview.data : undefined;

  const create = useMutation({
    mutationFn: () => api.post('/api/purchases', draft.toRequest()),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['purchases'] });
      // Stock and its average cost have both moved.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: ['outstanding'] });
      onClose();
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready = draft.canPreview && !preview.isError && !create.isPending;

  /**
   * A product's units only come with the detail endpoint, and the purchase line
   * needs them to know the mill might be billing in kg. Fetched on selection
   * rather than eagerly for the whole search result set.
   */
  async function chooseProduct(productId: string) {
    const { product } = await api.get<{ product: ProductDetail }>(
      `/api/masters/products/${productId}`,
    );
    draft.addProduct(product);
    setProductQuery('');
    productBox.current?.clear();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Enter supplier bill"
      size="wide"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}>
            Save bill
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={create.error} />

        {priced?.warnings?.length ? (
          <Alert tone="warning" title="Worth checking">
            <ul className="list-inside list-disc space-y-0.5">
              {priced.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {draft.supplier ? (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
            <div className="min-w-0">
              <p className="text-xs text-slate-500">Supplier</p>
              <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                {draft.supplier.displayName}
              </p>
              <p className="font-mono text-xs text-slate-500">
                {draft.supplier.gstin ?? 'Unregistered'}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => draft.setSupplier(null)}>
              Change
            </Button>
          </div>
        ) : (
          <Combobox<PartyListItem>
            ref={supplierBox}
            label="Supplier"
            placeholder="Mill or wholesaler name…"
            autoFocus
            items={suppliers.data?.parties ?? []}
            loading={suppliers.isFetching}
            pending={supplierPending || suppliers.isFetching}
            itemKey={(p) => p.id}
            itemLabel={(p) => p.displayName}
            onSearch={setSupplierQuery}
            onSelect={draft.setSupplier}
            renderItem={(p) => (
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{p.displayName}</p>
                <p className="font-mono text-xs text-slate-500">{p.gstin ?? 'Unregistered'}</p>
              </div>
            )}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Their bill number"
            value={draft.invoiceNumber}
            onChange={(e) => draft.setInvoiceNumber(e.target.value)}
            error={fieldErrors['supplierInvoiceNumber']}
            // GSTR-2B matches on this, so it matters more than our own number.
            hint="As printed — this is what GST reconciliation matches on"
            required
            className="font-mono"
            placeholder="JK/2026/881"
          />
          <Field
            label="Their bill date"
            type="date"
            value={draft.invoiceDate}
            onChange={(e) => draft.setInvoiceDate(e.target.value)}
            error={fieldErrors['supplierInvoiceDate']}
            required
          />
        </div>

        <Combobox
          ref={productBox}
          label="Add item"
          placeholder="Product name…"
          disabled={!draft.supplier}
          hint={!draft.supplier ? 'Pick a supplier first' : undefined}
          items={products.data?.products ?? []}
          loading={products.isFetching}
          pending={productPending || products.isFetching}
          itemKey={(p) => p.id}
          itemLabel={() => ''}
          onSearch={setProductQuery}
          onSelect={(p) => void chooseProduct(p.id)}
          renderItem={(p) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900 dark:text-slate-100">{p.name}</p>
                <p className="text-xs text-slate-500">HSN {p.hsnCode?.code ?? '—'}</p>
              </div>
              <span className="tabular shrink-0 text-xs text-slate-500">
                {formatQuantity(p.quantityOnHand)} {p.baseUnit?.symbol ?? ''}
              </span>
            </div>
          )}
        />

        <PurchaseLinesTable
          lines={draft.lines}
          pricedLines={priced?.lines}
          onUpdate={draft.updateLine}
          onRemove={draft.removeLine}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Freight / cartage"
            value={draft.freight}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) draft.setFreight(v);
            }}
            inputMode="decimal"
            // Freight is part of what the goods cost, so it is spread across
            // the lines by value rather than expensed separately.
            hint="Spread across the lines, into the cost"
            className="tabular"
            placeholder="0"
          />
          <Field
            label="Total on their bill"
            value={draft.supplierTotal}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) draft.setSupplierTotal(v);
            }}
            inputMode="decimal"
            hint="Optional — we'll check our figure against it"
            className="tabular"
            placeholder="0"
          />
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.itcEligible}
            onChange={(e) => draft.setItcEligible(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Input credit can be claimed
            </span>
            <span className="block text-xs text-slate-500">
              Untick for blocked credit. When ticked, the GST is excluded from the stock cost
              because it comes back.
            </span>
          </span>
        </label>

        {priced ? <PurchaseSummary priced={priced} /> : null}
      </div>
    </Dialog>
  );
}

function PurchaseSummary({ priced }: { priced: PurchasePreviewResponse }) {
  const mismatch = priced.reconciliation && !priced.reconciliation.matches;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <Row label="Taxable value" value={priced.totals.taxableValue} />
      {priced.supplyType === 'INTER_STATE' ? (
        <Row label="IGST" value={priced.totals.totalIgst} />
      ) : (
        <>
          <Row label="CGST" value={priced.totals.totalCgst} />
          <Row label="SGST" value={priced.totals.totalSgst} />
        </>
      )}
      {Number(priced.totals.freightCharges) > 0 ? (
        <Row label="Freight" value={priced.totals.freightCharges} />
      ) : null}

      <div className="flex justify-between border-t border-slate-200 pt-2 dark:border-slate-800">
        <span className="font-semibold text-slate-900 dark:text-slate-100">Bill total</span>
        <span className="tabular text-lg font-semibold text-slate-900 dark:text-slate-100">
          {formatMoney(priced.totals.grandTotal)}
        </span>
      </div>

      {priced.itcEligible && Number(priced.inputTaxCredit) > 0 ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {formatMoney(priced.inputTaxCredit)} claimable as input credit.
        </p>
      ) : null}

      {mismatch ? (
        <Alert tone="warning" title="Does not match their bill">
          Our figure differs by {formatMoney(priced.reconciliation!.difference)}. Check the
          quantities, rates and freight before saving — a mismatch here becomes a GSTR-2B problem
          later.
        </Alert>
      ) : priced.reconciliation?.matches ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          ✓ Matches the total on their bill.
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <span className="tabular text-slate-900 dark:text-slate-100">{formatMoney(value)}</span>
    </div>
  );
}
