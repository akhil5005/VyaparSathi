import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { formatMoney, formatQuantity } from '../../lib/money';
import type { ProductListItem, ProductListResponse } from '../../lib/types';
import { CAN_EDIT_MASTERS, CAN_SEE_COST, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { NewProductDialog } from './NewProductDialog';
import { Link } from 'react-router-dom';
import { Alert } from '../../components/Alert';
import type { HsnCode } from '../../lib/types';
import { ProductDetailDialog } from './ProductDetailDialog';

/**
 * Products and what is on the shelf.
 *
 * The list is a stock report first and a catalogue second — the column that
 * matters is how many are left, and whether that is below the reorder level.
 * Cost and stock value are hidden from billing staff, matching the server,
 * which strips them from responses for those roles rather than trusting the UI.
 */
export function ProductsPage() {
  const { can } = useAuth();
  const canEdit = can(...CAN_EDIT_MASTERS);
  const canSeeCost = can(...CAN_SEE_COST);

  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openProductId, setOpenProductId] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search);

  /**
   * A product cannot exist without an HSN code, and a freshly registered shop
   * has none — so "New product" leads to a form that cannot be completed.
   * Better to say so here than to let someone find out inside the dialog.
   */
  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<{ hsnCodes: HsnCode[] }>('/api/masters/hsn'),
  });
  const noHsnYet = !hsn.isLoading && (hsn.data?.hsnCodes.length ?? 0) === 0;

  const products = useQuery({
    queryKey: ['products', 'list', debouncedSearch, lowStockOnly],
    queryFn: () =>
      api.get<ProductListResponse>('/api/masters/products', {
        query: {
          search: debouncedSearch || undefined,
          lowStockOnly: lowStockOnly || undefined,
          pageSize: 100,
        },
      }),
  });

  const rows = products.data?.products ?? [];
  const lowCount = rows.filter((p) => p.lowStock).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Products &amp; stock
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {products.data ? `${products.data.total} product${products.data.total === 1 ? '' : 's'}` : ' '}
            {lowCount > 0 ? ` · ${lowCount} running low` : ''}
          </p>
        </div>
        {canEdit ? (
          <Button size="lg" onClick={() => setCreating(true)} disabled={noHsnYet}>
            New product
          </Button>
        ) : null}
      </header>

      {noHsnYet && canEdit ? (
        <Alert tone="warning" title="Set up GST rates first">
          Every product needs an HSN code — it is what decides the GST on a bill, and none are set
          up yet. Add one under{' '}
          <Link to="/settings" className="font-medium underline underline-offset-2">
            Settings → GST rates
          </Link>
          , then come back.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, SKU or brand…"
          className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
        />
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(event) => setLowStockOnly(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Only what's running low
        </label>
      </div>

      {products.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-slate-400" />
        </div>
      ) : products.error ? (
        <ErrorAlert error={products.error} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500 dark:border-slate-700">
          {search || lowStockOnly ? 'Nothing matches that.' : 'No products yet.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                  <th className="px-4 py-2.5 font-medium">Product</th>
                  <th className="px-3 py-2.5 font-medium">HSN</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sale rate</th>
                  <th className="px-3 py-2.5 text-right font-medium">In stock</th>
                  {canSeeCost ? (
                    <th className="px-4 py-2.5 text-right font-medium">Stock value</th>
                  ) : null}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    canSeeCost={canSeeCost}
                    onOpen={() => setOpenProductId(product.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating ? (
        <NewProductDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenProductId(id);
          }}
        />
      ) : null}

      {openProductId ? (
        <ProductDetailDialog
          productId={openProductId}
          onClose={() => setOpenProductId(null)}
        />
      ) : null}
    </div>
  );
}

function ProductRow({
  product,
  canSeeCost,
  onOpen,
}: {
  product: ProductListItem;
  canSeeCost: boolean;
  onOpen: () => void;
}) {
  const onHand = Number(product.quantityOnHand);
  const stockTone =
    onHand <= 0
      ? 'text-rose-600 dark:text-rose-400'
      : product.lowStock
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-900 dark:text-slate-100';

  return (
    <tr
      onClick={onOpen}
      tabIndex={0}
      role="button"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none dark:hover:bg-slate-800/40 dark:focus:bg-slate-800/40"
    >
      <td className="px-4 py-3">
        <p className="font-medium text-slate-900 dark:text-slate-100">{product.name}</p>
        <p className="text-xs text-slate-500">
          {[product.brand, product.sku, product.gsm ? `${product.gsm} gsm` : null, product.sheetSize]
            .filter(Boolean)
            .join(' · ') || 'No specification'}
        </p>
      </td>

      <td className="px-3 py-3 font-mono text-xs text-slate-500">
        {product.hsnCode?.code ?? '—'}
      </td>

      <td className="tabular px-3 py-3 text-right text-slate-700 dark:text-slate-300">
        {product.defaultSaleRate ? formatMoney(product.defaultSaleRate) : '—'}
      </td>

      <td className={`tabular px-3 py-3 text-right font-medium ${stockTone}`}>
        {formatQuantity(product.quantityOnHand)}{' '}
        <span className="text-xs font-normal text-slate-400">
          {product.baseUnit?.symbol ?? ''}
        </span>
        {onHand <= 0 ? (
          <p className="text-xs font-normal">Out of stock</p>
        ) : product.lowStock ? (
          <p className="text-xs font-normal">
            Reorder at {formatQuantity(product.reorderLevel)}
          </p>
        ) : null}
      </td>

      {canSeeCost ? (
        <td className="tabular px-4 py-3 text-right text-slate-600 dark:text-slate-400">
          {formatMoney(product.stockValue)}
        </td>
      ) : null}
    </tr>
  );
}
