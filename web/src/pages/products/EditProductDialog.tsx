import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { reamWeightKg } from './paperWeight';
import type { HsnCode, ProductDetail } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Correcting a product.
 *
 * What can be changed here is deliberately narrower than what "New product"
 * asks for, and the omissions are the interesting part:
 *
 *   - **The base unit cannot change.** Stock, costs and every past invoice line
 *     are denominated in it. Switching reams to kilograms after a hundred bills
 *     would not convert the history; it would silently reinterpret it.
 *
 *   - **Opening stock is not here.** It is a one-time migration figure that
 *     seeded the weighted-average cost. Correcting stock is what "Adjust stock"
 *     is for, and that leaves an audit trail.
 *
 * Changing the HSN code *is* allowed, because a genuinely miscoded product is a
 * real and common mistake — but past invoices keep the rate they were issued
 * with, since each line snapshots its own tax.
 */
export function EditProductDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(product.name);
  const [brand, setBrand] = useState(product.brand ?? '');
  const [sku, setSku] = useState(product.sku ?? '');
  const [hsnCodeId, setHsnCodeId] = useState(product.hsnCodeId);
  const [gsm, setGsm] = useState(product.gsm ? String(product.gsm) : '');
  const [sheetSize, setSheetSize] = useState(product.sheetSize ?? '');
  const [sheetsPerReam, setSheetsPerReam] = useState(
    product.sheetsPerReam ? String(product.sheetsPerReam) : '',
  );
  const [saleRate, setSaleRate] = useState(product.defaultSaleRate ?? '');
  const [reorderLevel, setReorderLevel] = useState(product.reorderLevel ?? '');
  const [isActive, setIsActive] = useState(product.isActive);

  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<{ hsnCodes: HsnCode[] }>('/api/masters/hsn'),
  });

  const weight = reamWeightKg(Number(gsm), sheetSize, Number(sheetsPerReam));
  const hsnChanged = hsnCodeId !== product.hsnCodeId;

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ product: ProductDetail }>(`/api/masters/products/${product.id}`, {
        name: name.trim(),
        // Sent even when blank, not omitted — a PATCH ignores what it is not
        // given, so omitting an emptied field would leave the old value in
        // place and the edit would appear not to have worked.
        brand: brand.trim(),
        sku: sku.trim(),
        hsnCodeId,
        ...(Number(gsm) > 0 ? { gsm: Number(gsm) } : {}),
        ...(sheetSize.trim() ? { sheetSize: sheetSize.trim() } : {}),
        ...(Number(sheetsPerReam) > 0 ? { sheetsPerReam: Number(sheetsPerReam) } : {}),
        ...(saleRate !== '' ? { defaultSaleRate: String(saleRate) } : {}),
        ...(reorderLevel !== '' ? { reorderLevel: String(reorderLevel) } : {}),
        isActive,
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onSaved();
    },
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const ready = name.trim().length >= 2 && hsnCodeId && !save.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) save.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${product.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={save.isPending} disabled={!ready}>
            Save changes
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={save.error} />

        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors['name']}
          required
          autoFocus
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            error={fieldErrors['brand']}
          />
          <Field
            label="SKU"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            error={fieldErrors['sku']}
          />
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
            HSN code
          </span>
          <select
            value={hsnCodeId}
            disabled={hsn.isLoading}
            onChange={(event) => setHsnCodeId(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700"
          >
            {(hsn.data?.hsnCodes ?? []).map((h) => (
              <option key={h.id} value={h.id}>
                {h.code} — {h.description}
              </option>
            ))}
          </select>
          {fieldErrors['hsnCodeId'] ? (
            <span className="mt-1.5 block text-sm text-rose-600">{fieldErrors['hsnCodeId']}</span>
          ) : null}
        </label>

        {hsnChanged ? (
          <Alert tone="warning">
            Changing the HSN changes the GST charged on this product from the next bill onwards.
            Bills already issued keep the rate they were issued with — each line stores its own tax,
            so history is not rewritten.
          </Alert>
        ) : null}

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Paper specification
          </legend>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="GSM"
              value={gsm}
              onChange={(e) => setGsm(e.target.value.replace(/\D/g, ''))}
              error={fieldErrors['gsm']}
              inputMode="numeric"
            />
            <Field
              label="Sheet size"
              value={sheetSize}
              onChange={(e) => setSheetSize(e.target.value)}
              error={fieldErrors['sheetSize']}
            />
            <Field
              label="Sheets / ream"
              value={sheetsPerReam}
              onChange={(e) => setSheetsPerReam(e.target.value.replace(/\D/g, ''))}
              error={fieldErrors['sheetsPerReam']}
              inputMode="numeric"
            />
          </div>

          {weight ? (
            <p className="text-xs text-slate-500">
              One {sheetSize} ream of {gsm} gsm weighs {weight.toFixed(4)} kg.
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Sale rate"
            value={String(saleRate)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setSaleRate(v);
            }}
            error={fieldErrors['defaultSaleRate']}
            inputMode="decimal"
            hint="Per unit, before GST"
            className="tabular"
          />
          <Field
            label="Reorder level"
            value={String(reorderLevel)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setReorderLevel(v);
            }}
            error={fieldErrors['reorderLevel']}
            inputMode="decimal"
            hint="Warn below this"
            className="tabular"
          />
        </div>

        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={!isActive}
            onChange={(event) => setIsActive(!event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Discontinued — hide from billing
            </span>
            <span className="block text-xs text-slate-500">
              Stock and history stay exactly as they are. This only stops it being picked on a new
              bill, which is what you want for a line the mill has stopped making.
            </span>
          </span>
        </label>

        <p className="text-xs text-slate-500">
          Counted in <strong>{product.baseUnit?.name ?? 'its base unit'}</strong>, which cannot be
          changed — stock, costs and every past bill are measured in it.
        </p>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
