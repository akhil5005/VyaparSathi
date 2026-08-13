import { Prisma } from '@prisma/client';
import { D, round2, ZERO } from '../../lib/money.js';
import type {
  Gstr1B2b,
  Gstr1B2cl,
  Gstr1B2cs,
  Gstr1Cdnr,
  Gstr1Cdnur,
  Gstr1DocDetail,
  Gstr1DocSeries,
  Gstr1HsnRow,
  Gstr1Item,
} from './gstr1.types.js';

/**
 * Turning issued documents into GSTR-1 sections.
 *
 * Pure by design: everything here takes plain objects and returns plain
 * objects, with no database and no clock. A return is a legal filing and the
 * classification rules below are the part most likely to be wrong, so they are
 * testable without a database — and they are tested.
 */

/**
 * The B2C Large threshold.
 *
 * An **inter-state** supply to an unregistered person above this figure is
 * reported invoice by invoice (B2CL); at or below it, only as a state-and-rate
 * total (B2CS). Intra-state B2C is always B2CS whatever the value.
 *
 * The figure has moved before — it stood at ₹2,50,000 for years and was
 * reduced to ₹1,00,000 — so it lives here as one named constant rather than
 * scattered through the logic. Worth confirming with the CA before a first
 * filing.
 */
export const B2CL_THRESHOLD = 100_000;

/** One line of a document, as the sections need it. */
export interface SourceLine {
  hsnCode: string;
  uqc: string;
  quantity: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  cgstRate: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstRate: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstRate: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  cessAmount: Prisma.Decimal;
}

export interface SourceDocument {
  number: string;
  date: Date;
  /** The counterparty's GSTIN, or null if they are unregistered. */
  partyGstin: string | null;
  placeOfSupply: string;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  reverseCharge: boolean;
  /** Document value including tax — what the customer actually pays. */
  grandTotal: Prisma.Decimal;
  lines: SourceLine[];
}

export interface SourceNote extends SourceDocument {
  noteType: 'CREDIT_NOTE' | 'DEBIT_NOTE';
}

/** dd-mm-yyyy, the only date format the portal accepts. */
export function portalDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

/** "2026-08" -> "082026". The portal wants MMYYYY, not ISO. */
export function portalPeriod(period: string): string {
  const [year, month] = period.split('-');
  return `${month}${year}`;
}

/**
 * The combined rate for a line, as the portal wants it: 18, not 9 + 9.
 *
 * Intra-state tax is stored as two halves and the return reports their sum.
 * Adding the *rates* rather than deriving a rate from the amounts avoids a
 * rounding artefact turning 18 into 17.99.
 */
function combinedRate(line: SourceLine): number {
  const rate = D(line.igstRate).greaterThan(0)
    ? D(line.igstRate)
    : D(line.cgstRate).plus(D(line.sgstRate));
  return Number(round2(rate));
}

interface TaxBucket {
  txval: Prisma.Decimal;
  iamt: Prisma.Decimal;
  camt: Prisma.Decimal;
  samt: Prisma.Decimal;
  csamt: Prisma.Decimal;
}

const emptyBucket = (): TaxBucket => ({
  txval: ZERO(),
  iamt: ZERO(),
  camt: ZERO(),
  samt: ZERO(),
  csamt: ZERO(),
});

function addLine(bucket: TaxBucket, line: SourceLine): TaxBucket {
  return {
    txval: bucket.txval.plus(D(line.taxableValue)),
    iamt: bucket.iamt.plus(D(line.igstAmount)),
    camt: bucket.camt.plus(D(line.cgstAmount)),
    samt: bucket.samt.plus(D(line.sgstAmount)),
    csamt: bucket.csamt.plus(D(line.cessAmount)),
  };
}

/**
 * Lines collapsed to one entry per rate.
 *
 * The portal reports tax per *rate*, not per product: three lines all at 18%
 * are one entry. Summing before rounding — rather than rounding each line and
 * then summing — is what keeps the section total equal to the invoice total.
 */
function itemsByRate(lines: SourceLine[]): Gstr1Item[] {
  const byRate = new Map<number, TaxBucket>();

  for (const line of lines) {
    const rate = combinedRate(line);
    byRate.set(rate, addLine(byRate.get(rate) ?? emptyBucket(), line));
  }

  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rt, v], index) => ({
      num: index + 1,
      itm_det: {
        rt,
        txval: Number(round2(v.txval)),
        iamt: Number(round2(v.iamt)),
        camt: Number(round2(v.camt)),
        samt: Number(round2(v.samt)),
        csamt: Number(round2(v.csamt)),
      },
    }));
}

/**
 * Which section an outward supply belongs in.
 *
 * The most consequential classification in the return:
 *   - counterparty has a GSTIN               -> B2B, invoice-wise
 *   - unregistered, inter-state, above limit -> B2CL, invoice-wise
 *   - anything else                          -> B2CS, state-and-rate totals
 */
export function classify(doc: SourceDocument): 'B2B' | 'B2CL' | 'B2CS' {
  if (doc.partyGstin) return 'B2B';
  if (doc.supplyType === 'INTER_STATE' && D(doc.grandTotal).greaterThan(B2CL_THRESHOLD)) {
    return 'B2CL';
  }
  return 'B2CS';
}

/** B2B, grouped by counterparty GSTIN as the portal expects. */
export function buildB2b(docs: SourceDocument[]): Gstr1B2b[] {
  const byGstin = new Map<string, Gstr1B2b>();

  for (const doc of docs) {
    if (!doc.partyGstin) continue;
    const entry = byGstin.get(doc.partyGstin) ?? { ctin: doc.partyGstin, inv: [] };
    entry.inv.push({
      inum: doc.number,
      idt: portalDate(doc.date),
      val: Number(round2(D(doc.grandTotal))),
      pos: doc.placeOfSupply,
      rchrg: doc.reverseCharge ? 'Y' : 'N',
      inv_typ: 'R',
      itms: itemsByRate(doc.lines),
    });
    byGstin.set(doc.partyGstin, entry);
  }

  return [...byGstin.values()];
}

/** B2CL, grouped by place of supply. */
export function buildB2cl(docs: SourceDocument[]): Gstr1B2cl[] {
  const byPos = new Map<string, Gstr1B2cl>();

  for (const doc of docs) {
    const entry = byPos.get(doc.placeOfSupply) ?? { pos: doc.placeOfSupply, inv: [] };
    entry.inv.push({
      inum: doc.number,
      idt: portalDate(doc.date),
      val: Number(round2(D(doc.grandTotal))),
      itms: itemsByRate(doc.lines),
    });
    byPos.set(doc.placeOfSupply, entry);
  }

  return [...byPos.values()];
}

/**
 * B2CS — every small sale in the period, aggregated.
 *
 * There is no invoice number anywhere in this section: the portal wants only
 * totals per state per rate, which is why a counter selling to walk-ins does
 * not have to report a hundred small bills individually.
 */
export function buildB2cs(docs: SourceDocument[]): Gstr1B2cs[] {
  const byKey = new Map<
    string,
    { sply_ty: 'INTRA' | 'INTER'; pos: string; rt: number; bucket: TaxBucket }
  >();

  for (const doc of docs) {
    const sply_ty = doc.supplyType === 'INTER_STATE' ? 'INTER' : 'INTRA';

    for (const line of doc.lines) {
      const rt = combinedRate(line);
      const key = `${sply_ty}|${doc.placeOfSupply}|${rt}`;
      const row = byKey.get(key) ?? { sply_ty, pos: doc.placeOfSupply, rt, bucket: emptyBucket() };
      row.bucket = addLine(row.bucket, line);
      byKey.set(key, row);
    }
  }

  return [...byKey.values()].map((row) => ({
    sply_ty: row.sply_ty,
    pos: row.pos,
    typ: 'OE' as const,
    rt: row.rt,
    txval: Number(round2(row.bucket.txval)),
    iamt: Number(round2(row.bucket.iamt)),
    camt: Number(round2(row.bucket.camt)),
    samt: Number(round2(row.bucket.samt)),
    csamt: Number(round2(row.bucket.csamt)),
  }));
}

/** CDNR — notes issued to a registered person, grouped by their GSTIN. */
export function buildCdnr(notes: SourceNote[]): Gstr1Cdnr[] {
  const byGstin = new Map<string, Gstr1Cdnr>();

  for (const note of notes) {
    if (!note.partyGstin) continue;
    const entry = byGstin.get(note.partyGstin) ?? { ctin: note.partyGstin, nt: [] };
    entry.nt.push({
      ntty: note.noteType === 'CREDIT_NOTE' ? 'C' : 'D',
      nt_num: note.number,
      nt_dt: portalDate(note.date),
      val: Number(round2(D(note.grandTotal))),
      pos: note.placeOfSupply,
      rchrg: note.reverseCharge ? 'Y' : 'N',
      p_gst: 'N',
      itms: itemsByRate(note.lines),
    });
    byGstin.set(note.partyGstin, entry);
  }

  return [...byGstin.values()];
}

/**
 * CDNUR — notes to an unregistered person.
 *
 * Only notes against a B2CL supply belong here. A note against a small B2C
 * sale is netted into the B2CS totals instead, which is why this takes an
 * already-filtered list rather than deciding for itself.
 */
export function buildCdnur(notes: SourceNote[]): Gstr1Cdnur[] {
  return notes.map((note) => ({
    typ: 'B2CL' as const,
    ntty: note.noteType === 'CREDIT_NOTE' ? ('C' as const) : ('D' as const),
    nt_num: note.number,
    nt_dt: portalDate(note.date),
    val: Number(round2(D(note.grandTotal))),
    pos: note.placeOfSupply,
    itms: itemsByRate(note.lines),
  }));
}

/**
 * HSN summary across everything supplied in the period.
 *
 * Grouped by HSN *and* UQC: the same code sold by the ream and by the kilogram
 * is two rows, because a quantity total that mixes units means nothing.
 */
export function buildHsn(
  docs: SourceDocument[],
  descriptions: Map<string, string> = new Map(),
): Gstr1HsnRow[] {
  const byKey = new Map<
    string,
    { hsn: string; uqc: string; qty: Prisma.Decimal; bucket: TaxBucket }
  >();

  for (const doc of docs) {
    for (const line of doc.lines) {
      const key = `${line.hsnCode}|${line.uqc}`;
      const row = byKey.get(key) ?? {
        hsn: line.hsnCode,
        uqc: line.uqc,
        qty: ZERO(),
        bucket: emptyBucket(),
      };
      row.qty = row.qty.plus(D(line.quantity));
      row.bucket = addLine(row.bucket, line);
      byKey.set(key, row);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.uqc.localeCompare(b.uqc))
    .map((row, index) => ({
      num: index + 1,
      hsn_sc: row.hsn,
      desc: descriptions.get(row.hsn) ?? '',
      uqc: row.uqc,
      qty: Number(row.qty.toDecimalPlaces(3)),
      txval: Number(round2(row.bucket.txval)),
      iamt: Number(round2(row.bucket.iamt)),
      camt: Number(round2(row.bucket.camt)),
      samt: Number(round2(row.bucket.samt)),
      csamt: Number(round2(row.bucket.csamt)),
    }));
}

/**
 * A document series: the first and last number issued, the count, and how many
 * were cancelled.
 *
 * Numbers are compared as strings, which is right for a zero-padded sequence
 * like INV/0007/26-27 and wrong for an unpadded one. The numbering module pads
 * by default for exactly this reason.
 */
function series(numbers: string[], cancelled: number): Gstr1DocSeries | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort();
  return {
    num: 1,
    from: sorted[0]!,
    to: sorted[sorted.length - 1]!,
    totnum: numbers.length,
    cancel: cancelled,
    net_issue: numbers.length - cancelled,
  };
}

/**
 * The doc_issue section — where gap-free numbering becomes auditable.
 *
 * The portal is told the range issued, the total, and how many were cancelled;
 * if the count does not match the range, the numbering has a gap and the return
 * will be questioned. Cancelled invoices keep their number precisely so this
 * arithmetic still works, which is why `invoiceNumbers` must include them.
 */
export function buildDocIssue(args: {
  invoiceNumbers: string[];
  cancelledInvoices: number;
  creditNoteNumbers: string[];
  debitNoteNumbers: string[];
}): Gstr1DocDetail[] {
  const details: Gstr1DocDetail[] = [];

  const invoices = series(args.invoiceNumbers, args.cancelledInvoices);
  if (invoices) details.push({ doc_num: 1, docs: [invoices] });

  const debits = series(args.debitNoteNumbers, 0);
  if (debits) details.push({ doc_num: 4, docs: [debits] });

  const credits = series(args.creditNoteNumbers, 0);
  if (credits) details.push({ doc_num: 5, docs: [credits] });

  return details;
}
