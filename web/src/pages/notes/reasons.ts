import type { NoteReason } from '../../lib/types';

/**
 * Why a note is being raised, in the shopkeeper's words.
 *
 * The reason is not paperwork — it decides whether the goods come back. A
 * return puts stock on the shelf; a rate correction or a post-sale discount
 * moves only money. The server derives `affectsStock` from this, so picking the
 * wrong one silently misstates the stock figure, which is why each option says
 * plainly what it will do.
 */
export interface ReasonOption {
  id: NoteReason;
  label: string;
  detail: string;
  /// Whether the server will move stock for this reason. Shown, not sent —
  /// the server decides and the preview confirms it.
  movesStock: boolean;
}

export const CREDIT_NOTE_REASONS: ReasonOption[] = [
  {
    id: 'SALES_RETURN',
    label: 'Goods came back',
    detail: 'Customer returned the paper. Stock goes back on the shelf.',
    movesStock: true,
  },
  {
    id: 'DAMAGED_GOODS',
    label: 'Damaged on delivery',
    detail: 'Returned because it was spoiled. Stock comes back, so adjust it out separately if it is unsaleable.',
    movesStock: true,
  },
  {
    id: 'QUANTITY_SHORTAGE',
    label: 'Short delivered',
    detail: 'Billed more than was sent. Nothing comes back — the goods never left.',
    movesStock: false,
  },
  {
    id: 'RATE_DIFFERENCE',
    label: 'Rate was wrong',
    detail: 'Overcharged. Credits the difference; no goods move.',
    movesStock: false,
  },
  {
    id: 'POST_SALE_DISCOUNT',
    label: 'Discount agreed later',
    detail: 'A rebate settled after billing. Money only.',
    movesStock: false,
  },
  {
    id: 'CORRECTION',
    label: 'Correcting a mistake',
    detail: 'A billing error that is not any of the above.',
    movesStock: false,
  },
];

export const reasonOption = (id: NoteReason): ReasonOption | undefined =>
  CREDIT_NOTE_REASONS.find((r) => r.id === id);

export const reasonLabel = (id: NoteReason): string =>
  reasonOption(id)?.label ??
  id
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
