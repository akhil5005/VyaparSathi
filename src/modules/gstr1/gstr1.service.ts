import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { D, round2, ZERO } from '../../lib/money.js';
import { notFound } from '../../lib/errors.js';
import { periodRange } from '../purchases/gstSetOff.js';
import {
  B2CL_THRESHOLD,
  buildB2b,
  buildB2cl,
  buildB2cs,
  buildCdnr,
  buildCdnur,
  buildDocIssue,
  buildHsn,
  classify,
  portalPeriod,
  type SourceDocument,
  type SourceLine,
  type SourceNote,
} from './gstr1.build.js';
import type { Gstr1Return, Gstr1Summary } from './gstr1.types.js';

/**
 * GSTR-1 for a month, assembled from what was actually issued.
 *
 * This produces the JSON the GST portal's offline utility accepts, plus a
 * plain-language summary to check before anyone uploads anything. It is a
 * **working paper for the CA**, not a filing: nothing here talks to the portal,
 * and the return is not marked filed anywhere. The person who signs the return
 * is still the person responsible for it.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

/**
 * Only what the sections need. Selecting explicitly rather than pulling whole
 * rows keeps a busy month's query from dragging every snapshot column and the
 * cost of goods across the wire.
 */
const LINE_SELECT = {
  hsnCode: true,
  uqc: true,
  quantity: true,
  taxableValue: true,
  cgstRate: true,
  cgstAmount: true,
  sgstRate: true,
  sgstAmount: true,
  igstRate: true,
  igstAmount: true,
  cessAmount: true,
} satisfies Prisma.SalesInvoiceItemSelect & Prisma.CreditDebitNoteItemSelect;

type RawLine = { [K in keyof typeof LINE_SELECT]: Prisma.Decimal | string };

const toLine = (line: RawLine): SourceLine => ({
  hsnCode: String(line.hsnCode),
  uqc: String(line.uqc),
  quantity: D(line.quantity),
  taxableValue: D(line.taxableValue),
  cgstRate: D(line.cgstRate),
  cgstAmount: D(line.cgstAmount),
  sgstRate: D(line.sgstRate),
  sgstAmount: D(line.sgstAmount),
  igstRate: D(line.igstRate),
  igstAmount: D(line.igstAmount),
  cessAmount: D(line.cessAmount),
});

export interface Gstr1Result {
  summary: Gstr1Summary;
  json: Gstr1Return;
}

export async function buildGstr1(businessId: string, period: string): Promise<Gstr1Result> {
  const { fromDate, toDate } = periodRange(period);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { gstin: true, stateCode: true, gstRegistrationType: true },
  });
  if (!business) throw notFound('Business not found');

  const [invoiceRows, cancelledRows, noteRows, hsnMasters] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { businessId, status: 'ISSUED', invoiceDate: { gte: fromDate, lte: toDate } },
      orderBy: { invoiceNumber: 'asc' },
      select: {
        invoiceNumber: true,
        invoiceDate: true,
        partyGstin: true,
        placeOfSupply: true,
        supplyType: true,
        reverseCharge: true,
        grandTotal: true,
        // Not part of any section — read only so the summary can warn when
        // charges sit outside the taxable value. See warningsFor().
        freightCharges: true,
        otherCharges: true,
        items: { select: LINE_SELECT, orderBy: { lineNumber: 'asc' } },
      },
    }),

    /**
     * Cancelled invoices are excluded from every section — no supply took
     * place — but they still have to be counted in doc_issue, because their
     * number was issued and the portal checks the range against the count.
     */
    prisma.salesInvoice.findMany({
      where: { businessId, status: 'CANCELLED', invoiceDate: { gte: fromDate, lte: toDate } },
      select: { invoiceNumber: true },
    }),

    /**
     * Only notes against a *sale*. A note against a purchase is the supplier's
     * outward supply, and reporting it here would be declaring someone else's
     * sale as our own.
     */
    prisma.creditDebitNote.findMany({
      where: {
        businessId,
        status: 'ISSUED',
        againstSalesInvoiceId: { not: null },
        noteDate: { gte: fromDate, lte: toDate },
      },
      orderBy: { noteNumber: 'asc' },
      select: {
        noteNumber: true,
        noteDate: true,
        noteType: true,
        partyGstin: true,
        partyStateCode: true,
        supplyType: true,
        grandTotal: true,
        againstSalesInvoice: { select: { grandTotal: true, supplyType: true } },
        items: { select: LINE_SELECT, orderBy: { lineNumber: 'asc' } },
      },
    }),

    prisma.hsnCode.findMany({
      where: { businessId },
      select: { code: true, description: true },
    }),
  ]);

  const descriptions = new Map(hsnMasters.map((h) => [h.code, h.description]));

  const invoices: SourceDocument[] = invoiceRows.map((row) => ({
    // ISSUED invoices always carry a number; the column is nullable only
    // because a DRAFT has none yet.
    number: row.invoiceNumber ?? '',
    date: row.invoiceDate,
    partyGstin: row.partyGstin,
    placeOfSupply: row.placeOfSupply,
    supplyType: row.supplyType,
    reverseCharge: row.reverseCharge,
    grandTotal: D(row.grandTotal),
    lines: row.items.map(toLine),
  }));

  const notes: (SourceNote & { originalWasB2cl: boolean })[] = noteRows.map((row) => {
    const original = row.againstSalesInvoice;
    return {
      number: row.noteNumber,
      date: row.noteDate,
      noteType: row.noteType,
      partyGstin: row.partyGstin,
      // A note has no place-of-supply column of its own; it inherits the
      // customer's state, which is what the original invoice used.
      placeOfSupply: row.partyStateCode,
      supplyType: row.supplyType,
      reverseCharge: false,
      grandTotal: D(row.grandTotal),
      lines: row.items.map(toLine),
      /**
       * Whether the *original* invoice was reported invoice-wise decides where
       * the note goes: against a B2CL invoice it is reported individually in
       * CDNUR, against a small B2C sale it is netted into the B2CS totals.
       */
      originalWasB2cl:
        original !== null &&
        original.supplyType === 'INTER_STATE' &&
        D(original.grandTotal).greaterThan(B2CL_THRESHOLD),
    };
  });

  const b2bDocs = invoices.filter((doc) => classify(doc) === 'B2B');
  const b2clDocs = invoices.filter((doc) => classify(doc) === 'B2CL');
  const b2csDocs = invoices.filter((doc) => classify(doc) === 'B2CS');

  const registeredNotes = notes.filter((note) => note.partyGstin !== null);
  const unregisteredNotes = notes.filter((note) => note.partyGstin === null);
  const cdnurNotes = unregisteredNotes.filter((note) => note.originalWasB2cl);

  /**
   * A credit note against a small B2C sale reduces that month's B2CS totals
   * rather than appearing anywhere of its own. Negating the lines and feeding
   * them back through the same aggregation is what nets it off — and it is why
   * a B2CS row can legitimately come out negative in a month of heavy returns.
   */
  const b2csAdjustments = unregisteredNotes
    .filter((note) => !note.originalWasB2cl)
    .map((note) => ({
      ...note,
      lines: note.lines.map((line) =>
        note.noteType === 'CREDIT_NOTE' ? negate(line) : line,
      ),
    }));

  const b2b = buildB2b(b2bDocs);
  const b2cl = buildB2cl(b2clDocs);
  const b2cs = buildB2cs([...b2csDocs, ...b2csAdjustments]);
  const cdnr = buildCdnr(registeredNotes);
  const cdnur = buildCdnur(cdnurNotes);
  /**
   * The HSN summary covers the period's outward supply *net* of what came
   * back, so it ties to the totals below and to the sum of the sections. A
   * credit note therefore enters it with its signs flipped.
   */
  const hsn = buildHsn(
    [
      ...invoices,
      ...notes.map((note) => ({
        ...note,
        lines: note.noteType === 'CREDIT_NOTE' ? note.lines.map(negate) : note.lines,
      })),
    ],
    descriptions,
  );

  const docIssue = buildDocIssue({
    invoiceNumbers: [
      ...invoiceRows.map((row) => row.invoiceNumber ?? ''),
      ...cancelledRows.map((row) => row.invoiceNumber ?? ''),
    ].filter((number) => number !== ''),
    cancelledInvoices: cancelledRows.length,
    creditNoteNumbers: notes.filter((n) => n.noteType === 'CREDIT_NOTE').map((n) => n.number),
    debitNoteNumbers: notes.filter((n) => n.noteType === 'DEBIT_NOTE').map((n) => n.number),
  });

  const json: Gstr1Return = {
    gstin: business.gstin,
    fp: portalPeriod(period),
    version: 'GST3.2',
    // The offline utility computes its own hash; "hash" is the documented
    // placeholder every third-party generator sends.
    hash: 'hash',
    ...(b2b.length > 0 ? { b2b } : {}),
    ...(b2cl.length > 0 ? { b2cl } : {}),
    ...(b2cs.length > 0 ? { b2cs } : {}),
    ...(cdnr.length > 0 ? { cdnr } : {}),
    ...(cdnur.length > 0 ? { cdnur } : {}),
    ...(hsn.length > 0 ? { hsn: { data: hsn } } : {}),
    ...(docIssue.length > 0 ? { doc_issue: { doc_det: docIssue } } : {}),
  };

  const summary: Gstr1Summary = {
    period,
    periodLabel: periodLabel(period),
    gstin: business.gstin,
    counts: {
      b2bInvoices: b2bDocs.length,
      b2bCounterparties: b2b.length,
      b2clInvoices: b2clDocs.length,
      b2csRows: b2cs.length,
      creditNotes: notes.filter((n) => n.noteType === 'CREDIT_NOTE').length,
      debitNotes: notes.filter((n) => n.noteType === 'DEBIT_NOTE').length,
      hsnRows: hsn.length,
      cancelledInvoices: cancelledRows.length,
    },
    totals: totalsOf(invoices, notes),
    warnings: warningsFor({
      invoices,
      notes,
      hsn,
      toDate,
      composition: business.gstRegistrationType !== 'REGULAR',
      untaxedCharges: invoiceRows
        .filter((row) => D(row.freightCharges).plus(D(row.otherCharges)).greaterThan(0))
        .map((row) => row.invoiceNumber ?? ''),
    }),
  };

  return { summary, json };
}

/** Flips a line's sign so a credit note can be netted off a total. */
function negate(line: SourceLine): SourceLine {
  return {
    ...line,
    quantity: D(line.quantity).negated(),
    taxableValue: D(line.taxableValue).negated(),
    cgstAmount: D(line.cgstAmount).negated(),
    sgstAmount: D(line.sgstAmount).negated(),
    igstAmount: D(line.igstAmount).negated(),
    cessAmount: D(line.cessAmount).negated(),
  };
}

/**
 * Period totals, net of credit notes.
 *
 * Strings, not numbers — this half is for a human to read and to tally against
 * the sales register, so it stays in the same decimal discipline as the rest of
 * the codebase. Only the portal JSON is allowed floats.
 */
function totalsOf(invoices: SourceDocument[], notes: SourceNote[]): Gstr1Summary['totals'] {
  const acc = {
    taxableValue: ZERO(),
    cgst: ZERO(),
    sgst: ZERO(),
    igst: ZERO(),
    cess: ZERO(),
    invoiceValue: ZERO(),
  };

  for (const doc of invoices) {
    acc.invoiceValue = acc.invoiceValue.plus(D(doc.grandTotal));
    for (const line of doc.lines) {
      acc.taxableValue = acc.taxableValue.plus(D(line.taxableValue));
      acc.cgst = acc.cgst.plus(D(line.cgstAmount));
      acc.sgst = acc.sgst.plus(D(line.sgstAmount));
      acc.igst = acc.igst.plus(D(line.igstAmount));
      acc.cess = acc.cess.plus(D(line.cessAmount));
    }
  }

  for (const note of notes) {
    const sign = note.noteType === 'CREDIT_NOTE' ? -1 : 1;
    acc.invoiceValue = acc.invoiceValue.plus(D(note.grandTotal).times(sign));
    for (const line of note.lines) {
      acc.taxableValue = acc.taxableValue.plus(D(line.taxableValue).times(sign));
      acc.cgst = acc.cgst.plus(D(line.cgstAmount).times(sign));
      acc.sgst = acc.sgst.plus(D(line.sgstAmount).times(sign));
      acc.igst = acc.igst.plus(D(line.igstAmount).times(sign));
      acc.cess = acc.cess.plus(D(line.cessAmount).times(sign));
    }
  }

  return {
    taxableValue: round2(acc.taxableValue).toFixed(2),
    cgst: round2(acc.cgst).toFixed(2),
    sgst: round2(acc.sgst).toFixed(2),
    igst: round2(acc.igst).toFixed(2),
    cess: round2(acc.cess).toFixed(2),
    invoiceValue: round2(acc.invoiceValue).toFixed(2),
  };
}

/**
 * The things a human should look at before filing.
 *
 * None of these stop the return being produced. They are the ways a return
 * goes wrong quietly: a missing GSTIN that should have been B2B, an HSN with no
 * description that the portal will reject on upload, a period that has not
 * finished yet. Better said here, on screen, than discovered at the portal on
 * the eleventh.
 */
function warningsFor(args: {
  invoices: SourceDocument[];
  notes: SourceNote[];
  hsn: { hsn_sc: string; desc: string }[];
  toDate: Date;
  composition: boolean;
  /// Invoices carrying freight or other charges added *after* tax.
  untaxedCharges: string[];
}): Gstr1Summary['warnings'] {
  const warnings: Gstr1Summary['warnings'] = [];

  if (args.invoices.length === 0 && args.notes.length === 0) {
    warnings.push({
      code: 'EMPTY_PERIOD',
      message:
        'No issued invoices or credit notes in this period. A nil return still has to be filed.',
    });
  }

  if (args.toDate.getTime() > Date.now()) {
    warnings.push({
      code: 'PERIOD_NOT_OVER',
      message: 'This month has not finished. More invoices may still be issued.',
    });
  }

  if (args.composition) {
    warnings.push({
      code: 'COMPOSITION_DEALER',
      message:
        'This business is not registered as a regular dealer. Composition dealers file CMP-08 and GSTR-4, not GSTR-1.',
    });
  }

  const missingHsnDesc = args.hsn.filter((row) => row.desc.trim() === '');
  if (missingHsnDesc.length > 0) {
    warnings.push({
      code: 'HSN_DESCRIPTION_MISSING',
      message: `No description set for HSN ${missingHsnDesc
        .map((row) => row.hsn_sc)
        .join(', ')}. The portal rejects an HSN row without one — add it under Settings → GST rates.`,
    });
  }

  /**
   * Freight and other charges are added to the invoice total *after* tax, so
   * they never reach a section: the portal sees an invoice whose value exceeds
   * its taxable value plus tax, and the difference is untaxed.
   *
   * For a composite supply of goods, freight normally takes the rate of the
   * goods it carries. Fixing that means changing how invoices are computed —
   * which would not touch bills already issued — so this says so rather than
   * quietly adjusting a legal document after the fact.
   */
  if (args.untaxedCharges.length > 0) {
    warnings.push({
      code: 'CHARGES_OUTSIDE_TAXABLE_VALUE',
      message: `Freight or other charges were added after tax on ${args.untaxedCharges.join(', ')}. The portal will see an invoice value higher than the taxable value plus tax. Ask your CA whether that freight should have been taxed at the goods' rate.`,
    });
  }

  const largeB2c = args.invoices.filter(
    (doc) =>
      !doc.partyGstin &&
      doc.supplyType === 'INTRA_STATE' &&
      D(doc.grandTotal).greaterThan(B2CL_THRESHOLD),
  );
  if (largeB2c.length > 0) {
    warnings.push({
      code: 'LARGE_SALE_WITHOUT_GSTIN',
      message: `${largeB2c.length} invoice${largeB2c.length === 1 ? '' : 's'} over ₹${B2CL_THRESHOLD.toLocaleString('en-IN')} ${
        largeB2c.length === 1 ? 'has' : 'have'
      } no customer GSTIN (${largeB2c.map((d) => d.number).join(', ')}). If the buyer is registered, they cannot claim credit — check before filing.`,
    });
  }

  const zeroRated = args.invoices.filter((doc) =>
    doc.lines.some(
      (line) =>
        D(line.cgstRate).isZero() && D(line.sgstRate).isZero() && D(line.igstRate).isZero(),
    ),
  );
  if (zeroRated.length > 0) {
    warnings.push({
      code: 'ZERO_RATE_LINES',
      message: `${zeroRated.length} invoice${zeroRated.length === 1 ? '' : 's'} contain${
        zeroRated.length === 1 ? 's' : ''
      } a line taxed at 0%. Paper is taxable, so this is usually a missing HSN rate rather than an exempt supply.`,
    });
  }

  return warnings;
}
