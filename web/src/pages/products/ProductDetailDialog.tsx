import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate, formatMoney, formatPercent, formatQuantity } from '../../lib/money';
import type {
  KgConversion,
  ProductDetail,
  StockHistoryResponse,
  StockMovement,
  StockMovementType,
} from '../../lib/types';
import { CAN_EDIT_MASTERS, CAN_SEE_COST, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Spinner } from '../../components/Spinner';
import { AdjustStockDialog } from './AdjustStockDialog';
import { EditProductDialog } from './EditProductDialog';
import { Pagination, usePage } from '../../components/Pagination';

/// The movement list sits inside a dialog, so it stays short.
const HISTORY_PAGE_SIZE = 20;

/**
 * Everything about one product, and the two things you do to it: correct the
 * stock, and read back how it got to where it is.
 *
 * The movement list is the answer to "the shelf says 40 and the screen says
 * 45". Every line is append-only with a running balance, so a discrepancy can
 * be traced to the movement that caused it instead of argued about.
 */
export function ProductDetailDialog({
  productId,
  onClose,
}: {
  productId: string;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const canEdit = can(...CAN_EDIT_MASTERS);
  const canSeeCost = can(...CAN_SEE_COST);
  const [adjusting, setAdjusting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [page, setPage] = usePage([productId]);

  const product = useQuery({
    queryKey: ['products', productId],
    queryFn: () => api.get<{ product: ProductDetail }>(`/api/masters/products/${productId}`),
  });

  const history = useQuery({
    queryKey: ['products', productId, 'stock-history', page],
    queryFn: () =>
      api.get<StockHistoryResponse>(`/api/masters/products/${productId}/stock-history`, {
        query: { page, pageSize: HISTORY_PAGE_SIZE },
      }),
  });

  const kg = useQuery({
    queryKey: ['products', productId, 'kg-conversion'],
    queryFn: () => api.get<KgConversion>(`/api/masters/products/${productId}/kg-conversion`),
  });

  const p = product.data?.product;

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={p?.name ?? 'Product'}
        footer={
          <>
            {canEdit ? (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="secondary" onClick={() => setAdjusting(true)}>
                  Adjust stock
                </Button>
              </>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        {product.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-6 w-6 text-slate-400" />
          </div>
        ) : product.error ? (
          <ErrorAlert error={product.error} />
        ) : p ? (
          <div className="space-y-4">
            {/* A product whose HSN has no rate in force today cannot be taxed,
                so the server refuses to bill it. Say so before someone tries. */}
            {!p.billable ? (
              <Alert tone="error" title="Cannot be billed">
                HSN {p.hsnCode?.code} has no GST rate in force today. Add one under Settings before
                selling this.
              </Alert>
            ) : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="In stock"
                value={`${formatQuantity(p.quantityOnHand)} ${p.baseUnit?.symbol ?? ''}`}
                tone={
                  Number(p.quantityOnHand) <= 0 ? 'bad' : p.lowStock ? 'warn' : 'plain'
                }
              />
              <Stat
                label="Sale rate"
                value={p.defaultSaleRate ? formatMoney(p.defaultSaleRate) : '—'}
              />
              <Stat
                label="GST"
                value={p.currentTaxRate ? formatPercent(p.currentTaxRate.gstRate) : '—'}
              />
              {canSeeCost ? (
                <>
                  <Stat
                    label="Average cost"
                    value={p.stock ? formatMoney(p.stock.avgCostPerBaseUnit) : '—'}
                  />
                  <Stat label="Stock value" value={formatMoney(p.stockValue)} />
                </>
              ) : null}
              <Stat
                label="Reorder at"
                value={p.reorderLevel ? formatQuantity(p.reorderLevel) : 'Not set'}
              />
            </div>

            <Detail label="HSN">
              <span className="font-mono">{p.hsnCode?.code ?? '—'}</span>
            </Detail>

            {p.gsm || p.sheetSize ? (
              <Detail label="Specification">
                {[p.gsm ? `${p.gsm} gsm` : null, p.sheetSize, p.sheetsPerReam ? `${p.sheetsPerReam} sheets/ream` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Detail>
            ) : null}

            {kg.data?.available ? (
              <Detail label="Weight conversion">{kg.data.explanation}</Detail>
            ) : null}

            <Detail label="Units">
              <ul className="space-y-0.5">
                {p.productUnits.map((pu) => (
                  <li key={pu.id}>
                    <span className="font-medium">{pu.unit.name}</span>
                    {pu.conversionToBase !== '1' ? (
                      <span className="text-slate-500">
                        {' '}
                        — 1 {pu.unit.symbol} = {formatQuantity(pu.conversionToBase)}{' '}
                        {p.baseUnit?.symbol}
                      </span>
                    ) : (
                      <span className="text-slate-500"> — base unit</span>
                    )}
                    {pu.isSalesDefault ? <Tag>sells in</Tag> : null}
                    {pu.isPurchaseDefault ? <Tag>buys in</Tag> : null}
                  </li>
                ))}
              </ul>
            </Detail>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Stock movements
              </h3>
              {history.isLoading ? (
                <div className="flex justify-center py-6">
                  <Spinner className="h-5 w-5 text-slate-400" />
                </div>
              ) : !history.data?.movements.length ? (
                <p className="py-4 text-center text-sm text-slate-500">No movements yet.</p>
              ) : (
                <ul className="max-h-64 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                  {history.data.movements.map((movement) => (
                    <MovementRow key={movement.id} movement={movement} unit={p.baseUnit?.symbol} />
                  ))}
                </ul>
              )}

              <Pagination
                page={history.data?.page ?? page}
                pageSize={history.data?.pageSize ?? HISTORY_PAGE_SIZE}
                total={history.data?.total ?? 0}
                onPage={setPage}
                noun="movements"
              />
            </div>
          </div>
        ) : null}
      </Dialog>

      {editing && p ? (
        <EditProductDialog
          product={p}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void product.refetch();
          }}
        />
      ) : null}

      {adjusting && p ? (
        <AdjustStockDialog
          product={p}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            void product.refetch();
            void history.refetch();
          }}
        />
      ) : null}
    </>
  );
}

const MOVEMENT_LABEL: Record<StockMovementType, string> = {
  OPENING: 'Opening stock',
  PURCHASE_IN: 'Purchased',
  SALE_OUT: 'Sold',
  SALES_RETURN_IN: 'Sales return',
  PURCHASE_RETURN_OUT: 'Returned to supplier',
  ADJUSTMENT_IN: 'Adjusted up',
  ADJUSTMENT_OUT: 'Adjusted down',
  DAMAGE_OUT: 'Damaged',
};

function MovementRow({ movement, unit }: { movement: StockMovement; unit: string | undefined }) {
  const quantity = Number(movement.baseQuantity);
  const incoming = quantity >= 0;

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="text-slate-900 dark:text-slate-100">
          {MOVEMENT_LABEL[movement.movementType] ?? movement.movementType}
          {movement.referenceNumber ? (
            <span className="ml-1.5 font-mono text-xs text-slate-500">
              {movement.referenceNumber}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-slate-500">
          {formatDate(movement.movementDate)}
          {movement.notes ? ` · ${movement.notes}` : ''}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p
          className={[
            'tabular font-medium',
            incoming ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
          ].join(' ')}
        >
          {incoming ? '+' : ''}
          {formatQuantity(movement.baseQuantity)}
        </p>
        <p className="tabular text-xs text-slate-500">
          {formatQuantity(movement.balanceAfter)} {unit} left
        </p>
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'warn' | 'bad';
}) {
  const toneClass = {
    plain: 'text-slate-900 dark:text-slate-100',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
  }[tone];

  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`tabular text-base font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 text-slate-700 dark:text-slate-300">{children}</div>
    </div>
  );
}

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-1.5 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300">
    {children}
  </span>
);
