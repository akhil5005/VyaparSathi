import { useCallback, useState } from 'react';
import type { PartyListItem, ProductListItem } from '../../lib/types';

/**
 * The bill being typed, before the server has seen it.
 *
 * Holds *intent* only — which product, how many, at what rate. It deliberately
 * knows nothing about tax, discounts in rupees, or totals: those come back from
 * the preview endpoint. Keeping the two apart is what guarantees the figures on
 * screen are the same ones that will be printed, because both come from the
 * same server computation rather than one being a browser re-implementation of
 * the other.
 */

export interface DraftLine {
  /// Local only. The server assigns real line numbers at issue.
  key: string;
  productId: string;
  productName: string;
  hsnCode: string;
  unitId: string;
  unitName: string;
  /// Strings, because these are what the user typed. "10." and "" are valid
  /// intermediate states that a number would destroy.
  quantity: string;
  rate: string;
  discountPercent: string;
  availableStock: string;
}

let keyCounter = 0;
const nextKey = () => `line-${++keyCounter}`;

export function useBillingDraft() {
  const [party, setParty] = useState<PartyListItem | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [freight, setFreight] = useState('');
  const [notes, setNotes] = useState('');

  const addProduct = useCallback((product: ProductListItem) => {
    const unit = product.baseUnit;
    setLines((current) => [
      ...current,
      {
        key: nextKey(),
        productId: product.id,
        productName: product.name,
        hsnCode: product.hsnCode?.code ?? '',
        unitId: product.baseUnitId,
        unitName: unit?.name ?? '',
        quantity: '1',
        // The product's own price is the starting point; the counter overrides
        // it for a regular customer who has a rate agreed.
        rate: product.defaultSaleRate ?? '',
        discountPercent: '',
        availableStock: product.quantityOnHand ?? '0',
      },
    ]);
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<DraftLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((current) => current.filter((line) => line.key !== key));
  }, []);

  const reset = useCallback(() => {
    setParty(null);
    setLines([]);
    setFreight('');
    setNotes('');
  }, []);

  /**
   * The lines complete enough to price.
   *
   * A line being typed — quantity cleared while the operator retypes it — is
   * skipped rather than sent, so the preview doesn't flash a validation error
   * mid-keystroke.
   */
  const billableLines = lines.filter(
    (line) => Number(line.quantity) > 0 && line.rate !== '' && Number(line.rate) >= 0,
  );

  const canPreview = Boolean(party) && billableLines.length > 0;

  /// The request body both `/preview` and `POST /` expect.
  const toRequest = useCallback(
    (extra: { issue?: boolean } = {}) => ({
      partyId: party!.id,
      items: billableLines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitId: line.unitId,
        rate: line.rate,
        ...(Number(line.discountPercent) > 0 ? { discountPercent: line.discountPercent } : {}),
      })),
      ...(Number(freight) > 0 ? { freightCharges: freight } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...extra,
    }),
    [party, billableLines, freight, notes],
  );

  return {
    party,
    setParty,
    lines,
    addProduct,
    updateLine,
    removeLine,
    freight,
    setFreight,
    notes,
    setNotes,
    reset,
    billableLines,
    canPreview,
    toRequest,
  };
}
