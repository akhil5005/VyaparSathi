import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { reamWeightKg } from './paperWeight';
import type { HsnCode, ProductDetail, Unit } from '../../lib/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';

/**
 * Adding a product.
 *
 * The paper specification — gsm, sheet size, sheets per ream — is not
 * decoration. Give all three and the server derives how many kilograms a ream
 * weighs, which is what lets the same product be *bought* by weight from the
 * mill and *sold* by the ream over the counter without anyone doing the
 * arithmetic twice. That conversion is the single most valuable thing this
 * form collects, so the working is shown as it is typed.
 */
export function NewProductDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (productId: string) => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [sku, setSku] = useState('');
  const [hsnCodeId, setHsnCodeId] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');
  const [gsm, setGsm] = useState('');
  const [sheetSize, setSheetSize] = useState('A4');
  const [sheetsPerReam, setSheetsPerReam] = useState('500');
  const [saleRate, setSaleRate] = useState('');
  const [reorderLevel, setReorderLevel] = useState('');
  const [openingStock, setOpeningStock] = useState('');
  const [openingRate, setOpeningRate] = useState('');

  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<{ hsnCodes: HsnCode[] }>('/api/masters/hsn'),
  });

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<{ units: Unit[] }>('/api/masters/units'),
  });

  // Sensible defaults once the masters load: paper is 4802, sold by the ream.
  useEffect(() => {
    if (!hsnCodeId && hsn.data?.hsnCodes.length) {
      setHsnCodeId(hsn.data.hsnCodes.find((h) => h.code === '4802')?.id ?? hsn.data.hsnCodes[0]!.id);
    }
  }, [hsn.data, hsnCodeId]);

  useEffect(() => {
    if (!baseUnitId && units.data?.units.length) {
      setBaseUnitId(
        units.data.units.find((u) => /ream/i.test(u.name))?.id ?? units.data.units[0]!.id,
      );
    }
  }, [units.data, baseUnitId]);

  /// Mirrors the server's derivation so the operator sees it before saving.
  const weight = useMemo(
    () => reamWeightKg(Number(gsm), sheetSize, Number(sheetsPerReam)),
    [gsm, sheetSize, sheetsPerReam],
  );

  const create = useMutation({
    mutationFn: () =>
      api.post<{ product: ProductDetail }>('/api/masters/products', {
        name: name.trim(),
        ...(brand.trim() ? { brand: brand.trim() } : {}),
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        hsnCodeId,
        baseUnitId,
        ...(Number(gsm) > 0 ? { gsm: Number(gsm) } : {}),
        ...(sheetSize.trim() ? { sheetSize: sheetSize.trim() } : {}),
        ...(Number(sheetsPerReam) > 0 ? { sheetsPerReam: Number(sheetsPerReam) } : {}),
        ...(saleRate !== '' ? { defaultSaleRate: saleRate } : {}),
        ...(reorderLevel !== '' ? { reorderLevel } : {}),
        ...(Number(openingStock) > 0
          ? { openingStock, openingStockRate: openingRate || '0' }
          : {}),
      }),
    onSuccess(result) {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onCreated(result.product.id);
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready = name.trim().length >= 2 && hsnCodeId && baseUnitId && !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New product"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending} disabled={!ready}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={create.error} />

        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors['name']}
          required
          autoFocus
          placeholder="JK Copier A4 75gsm"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            error={fieldErrors['brand']}
            placeholder="JK Paper"
          />
          <Field
            label="SKU"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            error={fieldErrors['sku']}
            placeholder="Optional"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="HSN code"
            value={hsnCodeId}
            onChange={setHsnCodeId}
            error={fieldErrors['hsnCodeId']}
            hint="Decides the GST rate"
            loading={hsn.isLoading}
            emptyMessage={
              <>
                No HSN codes yet — add one under{' '}
                <Link to="/settings" className="font-medium underline underline-offset-2">
                  Settings → GST rates
                </Link>
                . A product cannot be billed without one.
              </>
            }
            options={(hsn.data?.hsnCodes ?? []).map((h) => ({
              value: h.id,
              label: `${h.code} — ${h.description}`,
            }))}
          />
          <Select
            label="Counted in"
            value={baseUnitId}
            onChange={setBaseUnitId}
            error={fieldErrors['baseUnitId']}
            hint="Stock is held in this unit"
            loading={units.isLoading}
            options={(units.data?.units ?? []).map((u) => ({
              value: u.id,
              label: `${u.name} (${u.symbol})`,
            }))}
          />
        </div>

        <fieldset className="space-y-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
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
              placeholder="75"
            />
            <Field
              label="Sheet size"
              value={sheetSize}
              onChange={(e) => setSheetSize(e.target.value)}
              error={fieldErrors['sheetSize']}
              placeholder="A4"
            />
            <Field
              label="Sheets / ream"
              value={sheetsPerReam}
              onChange={(e) => setSheetsPerReam(e.target.value.replace(/\D/g, ''))}
              error={fieldErrors['sheetsPerReam']}
              inputMode="numeric"
              placeholder="500"
            />
          </div>

          {weight ? (
            <Alert tone="success">
              One {sheetSize} ream of {gsm} gsm weighs <strong>{weight.toFixed(4)} kg</strong>. A kg
              conversion will be created automatically, so this can be bought by weight and sold by
              the ream.
            </Alert>
          ) : (
            <p className="text-xs text-slate-500">
              Fill all three and the reams↔kg conversion is worked out for you.
            </p>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Sale rate"
            value={saleRate}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setSaleRate(v);
            }}
            error={fieldErrors['defaultSaleRate']}
            inputMode="decimal"
            hint="Per unit, before GST"
            className="tabular"
            placeholder="240"
          />
          <Field
            label="Reorder level"
            value={reorderLevel}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setReorderLevel(v);
            }}
            error={fieldErrors['reorderLevel']}
            inputMode="decimal"
            hint="Warn below this"
            className="tabular"
            placeholder="20"
          />
        </div>

        <fieldset className="grid gap-4 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Opening stock
          </legend>
          <Field
            label="Quantity in hand"
            value={openingStock}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setOpeningStock(v);
            }}
            error={fieldErrors['openingStock']}
            inputMode="decimal"
            className="tabular"
            placeholder="0"
          />
          <Field
            label="Cost per unit"
            value={openingRate}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setOpeningRate(v);
            }}
            error={fieldErrors['openingStockRate']}
            inputMode="decimal"
            // This seeds the weighted average, so margin is wrong from the
            // first sale if it is guessed.
            hint="What it actually cost — seeds the average"
            className="tabular"
            placeholder="0"
          />
        </fieldset>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/**
 * A required dropdown that tells the truth about why it is empty.
 *
 * The first version printed "Loading…" whenever the option list was empty,
 * which conflates two completely different situations. On a freshly registered
 * shop there are no HSN codes yet, so it sat there saying "Loading…" for ever
 * with no hint that the fix is to go and add one — the worst possible first
 * five minutes with the software.
 */
function Select({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  loading = false,
  emptyMessage,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: React.ReactNode;
  error?: string;
  loading?: boolean;
  /// Shown instead of the hint when the list has loaded and is genuinely empty.
  emptyMessage?: React.ReactNode;
}) {
  const empty = !loading && options.length === 0;

  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label} <span className="text-rose-600">*</span>
      </span>
      <select
        value={value}
        disabled={loading || empty}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-700 dark:disabled:bg-slate-800"
      >
        {loading ? <option value="">Loading…</option> : null}
        {empty ? <option value="">None set up yet</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span className="mt-1.5 block text-sm text-rose-600">{error}</span>
      ) : empty && emptyMessage ? (
        <span className="mt-1.5 block text-sm text-amber-600 dark:text-amber-400">
          {emptyMessage}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-sm text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}
