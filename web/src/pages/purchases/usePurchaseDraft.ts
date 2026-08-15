import { useCallback, useState } from 'react';
import { todayInput } from '../../lib/money';
import type { PartyListItem, ProductDetail, ProductListItem } from '../../lib/types';

/**
 * The supplier bill being entered.
 *
 * Like the sales draft, this holds intent only — no money is computed here. It
 * differs in one important way: a purchase line carries its own **unit**,
 * because the mill bills in kilograms while the shop stocks reams, and the
 * whole point is to enter the bill exactly as printed and let the server do the
 * conversion.
 */

export interface PurchaseDraftLine {
  key: string;
  productId: string;
  productName: string;
  /// Which unit the supplier billed in. Defaults to the product's purchase
  /// unit, which for paper is normally kg.
  unitId: string;
  unitName: string;
  /// Available units to bill in, from the product's own conversions.
  unitOptions: { id: string; name: string; symbol: string }[];
  quantity: string;
  rate: string;
  discountPercent: string;
}

let keyCounter = 0;
const nextKey = () => `pline-${++keyCounter}`;

export function usePurchaseDraft() {
  const [supplier, setSupplier] = useState<PartyListItem | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayInput());
  const [lines, setLines] = useState<PurchaseDraftLine[]>([]);
  const [freight, setFreight] = useState('');
  const [supplierTotal, setSupplierTotal] = useState('');
  const [itcEligible, setItcEligible] = useState(true);
  const [notes, setNotes] = useState('');

  const addProduct = useCallback((product: ProductDetail | ProductListItem) => {
    const units = (product as ProductDetail).productUnits ?? [];
    // Prefer the unit the mill actually bills in.
    const purchaseUnit = units.find((u) => u.isPurchaseDefault) ?? units[0];

    setLines((current) => [
      ...current,
      {
        key: nextKey(),
        productId: product.id,
        productName: product.name,
        unitId: purchaseUnit?.unitId ?? product.baseUnitId,
        unitName: purchaseUnit?.unit.name ?? product.baseUnit?.name ?? '',
        unitOptions: units.map((u) => ({
          id: u.unitId,
          name: u.unit.name,
          symbol: u.unit.symbol,
        })),
        quantity: '',
        rate: product.defaultPurchaseRate ?? '',
        discountPercent: '',
      },
    ]);
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<PurchaseDraftLine>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((current) => current.filter((l) => l.key !== key));
  }, []);

  /**
   * Fills the draft from a scanned bill.
   *
   * Takes entities already fetched by the caller rather than ids, so this hook
   * stays free of data fetching and the scan path builds exactly the same draft
   * shape as typing would. A line whose product could not be matched is simply
   * not added — there is nothing to add it against — and the warning on the
   * review screen has already said so.
   */
  const applyScan = useCallback(
    (scan: {
      supplier: PartyListItem | null;
      invoiceNumber: string | null;
      invoiceDate: string | null;
      freight: string | null;
      supplierTotal: string | null;
      lines: { product: ProductDetail; quantity: string | null; rate: string | null }[];
    }) => {
      if (scan.supplier) setSupplier(scan.supplier);
      if (scan.invoiceNumber) setInvoiceNumber(scan.invoiceNumber);
      if (scan.invoiceDate) setInvoiceDate(scan.invoiceDate);
      if (scan.freight) setFreight(scan.freight);
      if (scan.supplierTotal) setSupplierTotal(scan.supplierTotal);

      setLines(
        scan.lines.map(({ product, quantity, rate }) => {
          const units = product.productUnits ?? [];
          const purchaseUnit = units.find((u) => u.isPurchaseDefault) ?? units[0];
          return {
            key: nextKey(),
            productId: product.id,
            productName: product.name,
            unitId: purchaseUnit?.unitId ?? product.baseUnitId,
            unitName: purchaseUnit?.unit.name ?? product.baseUnit?.name ?? '',
            unitOptions: units.map((u) => ({
              id: u.unitId,
              name: u.unit.name,
              symbol: u.unit.symbol,
            })),
            // Blank rather than zero when unreadable: an empty box asks to be
            // filled, a zero looks like a decision somebody made.
            quantity: quantity ?? '',
            rate: rate ?? '',
            discountPercent: '',
          };
        }),
      );
    },
    [],
  );

  const reset = useCallback(() => {
    setSupplier(null);
    setInvoiceNumber('');
    setInvoiceDate(todayInput());
    setLines([]);
    setFreight('');
    setSupplierTotal('');
    setItcEligible(true);
    setNotes('');
  }, []);

  const billableLines = lines.filter(
    (l) => Number(l.quantity) > 0 && l.rate !== '' && Number(l.rate) >= 0,
  );

  const canPreview =
    Boolean(supplier) && invoiceNumber.trim().length > 0 && billableLines.length > 0;

  const toRequest = useCallback(
    (extra: { issue?: boolean } = {}) => ({
      partyId: supplier!.id,
      supplierInvoiceNumber: invoiceNumber.trim(),
      supplierInvoiceDate: invoiceDate,
      items: billableLines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitId: l.unitId,
        rate: l.rate,
        ...(Number(l.discountPercent) > 0 ? { discountPercent: l.discountPercent } : {}),
      })),
      ...(Number(freight) > 0 ? { freightCharges: freight } : {}),
      ...(Number(supplierTotal) > 0 ? { supplierGrandTotal: supplierTotal } : {}),
      itcEligible,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...extra,
    }),
    [supplier, invoiceNumber, invoiceDate, billableLines, freight, supplierTotal, itcEligible, notes],
  );

  return {
    supplier,
    setSupplier,
    invoiceNumber,
    setInvoiceNumber,
    invoiceDate,
    setInvoiceDate,
    lines,
    addProduct,
    applyScan,
    updateLine,
    removeLine,
    freight,
    setFreight,
    supplierTotal,
    setSupplierTotal,
    itcEligible,
    setItcEligible,
    notes,
    setNotes,
    reset,
    billableLines,
    canPreview,
    toRequest,
  };
}
