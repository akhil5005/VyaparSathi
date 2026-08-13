/**
 * GSTR-1 classification and aggregation.
 *
 * These rules decide what the tax department is told. A supply in the wrong
 * section is not a cosmetic bug — a B2B invoice landing in B2CS means the
 * customer never sees the credit, rings up about it, and the return has to be
 * amended. Every case here is a shape this shop actually issues.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../lib/money.js';
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
  portalDate,
  portalPeriod,
  type SourceDocument,
  type SourceLine,
  type SourceNote,
} from './gstr1.build.js';

/** An 18% intra-state line: the overwhelmingly common case here. */
function intraLine(taxable: number, over: Partial<SourceLine> = {}): SourceLine {
  const half = D(taxable).times(0.09);
  return {
    hsnCode: '4802',
    uqc: 'NOS',
    quantity: D(1),
    taxableValue: D(taxable),
    cgstRate: D(9),
    cgstAmount: half,
    sgstRate: D(9),
    sgstAmount: half,
    igstRate: D(0),
    igstAmount: D(0),
    cessAmount: D(0),
    ...over,
  };
}

function interLine(taxable: number, over: Partial<SourceLine> = {}): SourceLine {
  return {
    hsnCode: '4802',
    uqc: 'NOS',
    quantity: D(1),
    taxableValue: D(taxable),
    cgstRate: D(0),
    cgstAmount: D(0),
    sgstRate: D(0),
    sgstAmount: D(0),
    igstRate: D(18),
    igstAmount: D(taxable).times(0.18),
    cessAmount: D(0),
    ...over,
  };
}

function doc(over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    number: 'INV/0001/26-27',
    date: new Date(Date.UTC(2026, 7, 9)),
    partyGstin: null,
    placeOfSupply: '03',
    supplyType: 'INTRA_STATE',
    reverseCharge: false,
    grandTotal: D(1180),
    lines: [intraLine(1000)],
    ...over,
  };
}

describe('classify', () => {
  it('sends anything with a counterparty GSTIN to B2B, however small', () => {
    assert.equal(
      classify(doc({ partyGstin: '03AABCU9603R1ZM', grandTotal: D(59) })),
      'B2B',
    );
  });

  it('keeps a registered inter-state sale in B2B rather than B2CL', () => {
    const invoice = doc({
      partyGstin: '06AABCU9603R1ZM',
      supplyType: 'INTER_STATE',
      placeOfSupply: '06',
      grandTotal: D(500_000),
    });
    assert.equal(classify(invoice), 'B2B');
  });

  it('sends a large unregistered inter-state sale to B2CL', () => {
    const invoice = doc({
      supplyType: 'INTER_STATE',
      placeOfSupply: '06',
      grandTotal: D(B2CL_THRESHOLD + 1),
    });
    assert.equal(classify(invoice), 'B2CL');
  });

  it('keeps a large unregistered *intra*-state sale in B2CS', () => {
    // The threshold only ever applies inter-state. Getting this wrong puts a
    // local cash sale into a section reserved for other states.
    const invoice = doc({ grandTotal: D(B2CL_THRESHOLD * 5) });
    assert.equal(classify(invoice), 'B2CS');
  });

  it('treats a sale exactly at the threshold as B2CS, not B2CL', () => {
    const invoice = doc({
      supplyType: 'INTER_STATE',
      placeOfSupply: '06',
      grandTotal: D(B2CL_THRESHOLD),
    });
    assert.equal(classify(invoice), 'B2CS');
  });
});

describe('buildB2b', () => {
  it('groups every invoice for one customer under a single GSTIN entry', () => {
    const gstin = '03AABCU9603R1ZM';
    const b2b = buildB2b([
      doc({ partyGstin: gstin, number: 'INV/0001/26-27' }),
      doc({ partyGstin: gstin, number: 'INV/0004/26-27' }),
      doc({ partyGstin: '03AAACR5055K1Z7', number: 'INV/0002/26-27' }),
    ]);

    assert.equal(b2b.length, 2);
    const first = b2b.find((e) => e.ctin === gstin)!;
    assert.equal(first.inv.length, 2);
    assert.deepEqual(
      first.inv.map((i) => i.inum),
      ['INV/0001/26-27', 'INV/0004/26-27'],
    );
  });

  it('reports the combined rate, not the two halves', () => {
    const [entry] = buildB2b([doc({ partyGstin: '03AABCU9603R1ZM' })]);
    const item = entry!.inv[0]!.itms[0]!;
    assert.equal(item.itm_det.rt, 18);
    assert.equal(item.itm_det.camt, 90);
    assert.equal(item.itm_det.samt, 90);
    assert.equal(item.itm_det.iamt, 0);
  });

  it('collapses several lines at the same rate into one rate entry', () => {
    const invoice = doc({
      partyGstin: '03AABCU9603R1ZM',
      lines: [intraLine(1000), intraLine(500), intraLine(250)],
    });
    const [entry] = buildB2b([invoice]);
    const items = entry!.inv[0]!.itms;

    assert.equal(items.length, 1);
    assert.equal(items[0]!.itm_det.txval, 1750);
    assert.equal(items[0]!.itm_det.camt, 157.5);
  });

  it('keeps different rates apart and numbers them from 1, lowest first', () => {
    const invoice = doc({
      partyGstin: '03AABCU9603R1ZM',
      lines: [
        intraLine(1000),
        intraLine(400, { cgstRate: D(2.5), sgstRate: D(2.5), cgstAmount: D(10), sgstAmount: D(10) }),
      ],
    });
    const [entry] = buildB2b([invoice]);
    const items = entry!.inv[0]!.itms;

    assert.deepEqual(
      items.map((i) => [i.num, i.itm_det.rt]),
      [
        [1, 5],
        [2, 18],
      ],
    );
  });

  it('sums lines before rounding, so the section ties to the invoice', () => {
    // Three lines whose tax each ends in a half-paisa. Rounding line by line
    // would drift by a paisa from the invoice total; summing first does not.
    const third = (n: number) => intraLine(n, { cgstAmount: D(n).times(0.09), sgstAmount: D(n).times(0.09) });
    const invoice = doc({
      partyGstin: '03AABCU9603R1ZM',
      lines: [third(33.33), third(33.33), third(33.34)],
    });
    const [entry] = buildB2b([invoice]);
    const item = entry!.inv[0]!.itms[0]!.itm_det;

    assert.equal(item.txval, 100);
    assert.equal(item.camt, 9);
  });

  it('marks reverse charge with Y and everything else with N', () => {
    const [charged] = buildB2b([doc({ partyGstin: '03AABCU9603R1ZM', reverseCharge: true })]);
    const [normal] = buildB2b([doc({ partyGstin: '03AABCU9603R1ZM' })]);
    assert.equal(charged!.inv[0]!.rchrg, 'Y');
    assert.equal(normal!.inv[0]!.rchrg, 'N');
  });
});

describe('buildB2cl', () => {
  it('groups by place of supply and keeps invoice numbers', () => {
    const b2cl = buildB2cl([
      doc({ number: 'INV/0007/26-27', supplyType: 'INTER_STATE', placeOfSupply: '06', lines: [interLine(200_000)], grandTotal: D(236_000) }),
      doc({ number: 'INV/0009/26-27', supplyType: 'INTER_STATE', placeOfSupply: '06', lines: [interLine(150_000)], grandTotal: D(177_000) }),
      doc({ number: 'INV/0011/26-27', supplyType: 'INTER_STATE', placeOfSupply: '07', lines: [interLine(120_000)], grandTotal: D(141_600) }),
    ]);

    assert.deepEqual(b2cl.map((e) => e.pos).sort(), ['06', '07']);
    assert.equal(b2cl.find((e) => e.pos === '06')!.inv.length, 2);
  });

  it('charges IGST only', () => {
    const [entry] = buildB2cl([
      doc({ supplyType: 'INTER_STATE', placeOfSupply: '06', lines: [interLine(200_000)], grandTotal: D(236_000) }),
    ]);
    const item = entry!.inv[0]!.itms[0]!.itm_det;
    assert.equal(item.rt, 18);
    assert.equal(item.iamt, 36_000);
    assert.equal(item.camt, 0);
  });
});

describe('buildB2cs', () => {
  it('reports totals per state and rate with no invoice numbers anywhere', () => {
    const rows = buildB2cs([
      doc({ number: 'INV/0001/26-27', lines: [intraLine(1000)] }),
      doc({ number: 'INV/0002/26-27', lines: [intraLine(500)] }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.txval, 1500);
    assert.equal(rows[0]!.camt, 135);
    assert.equal(rows[0]!.sply_ty, 'INTRA');
    assert.equal(rows[0]!.pos, '03');
    assert.equal(rows[0]!.typ, 'OE');
    assert.ok(!JSON.stringify(rows).includes('INV/'));
  });

  it('separates intra-state from inter-state even for the same state code', () => {
    const rows = buildB2cs([
      doc({ lines: [intraLine(1000)] }),
      doc({ supplyType: 'INTER_STATE', lines: [interLine(1000)] }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.sply_ty).sort(), ['INTER', 'INTRA']);
  });

  it('separates rates within the same state', () => {
    const rows = buildB2cs([
      doc({
        lines: [
          intraLine(1000),
          intraLine(400, { cgstRate: D(2.5), sgstRate: D(2.5), cgstAmount: D(10), sgstAmount: D(10) }),
        ],
      }),
    ]);
    assert.deepEqual(rows.map((r) => r.rt).sort((a, b) => a - b), [5, 18]);
  });

  it('nets a negated credit note off the total for that state and rate', () => {
    const returned = intraLine(-300, { cgstAmount: D(-27), sgstAmount: D(-27) });
    const rows = buildB2cs([doc({ lines: [intraLine(1000)] }), doc({ lines: [returned] })]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.txval, 700);
    assert.equal(rows[0]!.camt, 63);
  });
});

describe('buildCdnr and buildCdnur', () => {
  const note = (over: Partial<SourceNote> = {}): SourceNote => ({
    ...doc(),
    number: 'CN/0001/26-27',
    noteType: 'CREDIT_NOTE',
    grandTotal: D(354),
    lines: [intraLine(300, { cgstAmount: D(27), sgstAmount: D(27) })],
    ...over,
  });

  it('groups registered notes by GSTIN and marks a credit note C', () => {
    const cdnr = buildCdnr([note({ partyGstin: '03AABCU9603R1ZM' })]);
    assert.equal(cdnr.length, 1);
    assert.equal(cdnr[0]!.nt[0]!.ntty, 'C');
    assert.equal(cdnr[0]!.nt[0]!.p_gst, 'N');
  });

  it('marks a debit note D', () => {
    const cdnr = buildCdnr([note({ partyGstin: '03AABCU9603R1ZM', noteType: 'DEBIT_NOTE' })]);
    assert.equal(cdnr[0]!.nt[0]!.ntty, 'D');
  });

  it('skips unregistered notes entirely — they are not CDNR', () => {
    assert.deepEqual(buildCdnr([note({ partyGstin: null })]), []);
  });

  it('reports unregistered notes flat, typed B2CL', () => {
    const cdnur = buildCdnur([note({ partyGstin: null, supplyType: 'INTER_STATE', placeOfSupply: '06' })]);
    assert.equal(cdnur.length, 1);
    assert.equal(cdnur[0]!.typ, 'B2CL');
    assert.equal(cdnur[0]!.pos, '06');
    assert.equal(cdnur[0]!.nt_num, 'CN/0001/26-27');
  });
});

describe('buildHsn', () => {
  it('splits the same HSN across units, because a mixed quantity means nothing', () => {
    const rows = buildHsn([
      doc({ lines: [intraLine(1000, { uqc: 'NOS', quantity: D(4) })] }),
      doc({ lines: [intraLine(2000, { uqc: 'KGS', quantity: D(50) })] }),
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.uqc).sort(), ['KGS', 'NOS']);
  });

  it('accumulates quantity and tax across invoices for one HSN and unit', () => {
    const rows = buildHsn([
      doc({ lines: [intraLine(1000, { quantity: D(4) })] }),
      doc({ lines: [intraLine(500, { quantity: D(2) })] }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.qty, 6);
    assert.equal(rows[0]!.txval, 1500);
    assert.equal(rows[0]!.camt, 135);
  });

  it('fills the description from the HSN master and numbers rows from 1', () => {
    const rows = buildHsn(
      [
        doc({ lines: [intraLine(1000, { hsnCode: '4820' })] }),
        doc({ lines: [intraLine(1000, { hsnCode: '4802' })] }),
      ],
      new Map([['4802', 'Uncoated paper']]),
    );

    assert.deepEqual(
      rows.map((r) => [r.num, r.hsn_sc, r.desc]),
      [
        [1, '4802', 'Uncoated paper'],
        [2, '4820', ''],
      ],
    );
  });
});

describe('buildDocIssue', () => {
  it('reports the range, the count and the cancellations', () => {
    const details = buildDocIssue({
      invoiceNumbers: ['INV/0001/26-27', 'INV/0002/26-27', 'INV/0003/26-27'],
      cancelledInvoices: 1,
      creditNoteNumbers: [],
      debitNoteNumbers: [],
    });

    assert.equal(details.length, 1);
    const series = details[0]!.docs[0]!;
    assert.equal(details[0]!.doc_num, 1);
    assert.equal(series.from, 'INV/0001/26-27');
    assert.equal(series.to, 'INV/0003/26-27');
    assert.equal(series.totnum, 3);
    assert.equal(series.cancel, 1);
    assert.equal(series.net_issue, 2);
  });

  it('files credit notes under 5 and debit notes under 4', () => {
    const details = buildDocIssue({
      invoiceNumbers: [],
      cancelledInvoices: 0,
      creditNoteNumbers: ['CN/0001/26-27'],
      debitNoteNumbers: ['DN/0001/26-27'],
    });
    assert.deepEqual(details.map((d) => d.doc_num), [4, 5]);
  });

  it('omits a document type that had none issued', () => {
    assert.deepEqual(
      buildDocIssue({
        invoiceNumbers: [],
        cancelledInvoices: 0,
        creditNoteNumbers: [],
        debitNoteNumbers: [],
      }),
      [],
    );
  });
});

describe('portal formats', () => {
  it('writes dates dd-mm-yyyy with both parts padded', () => {
    assert.equal(portalDate(new Date(Date.UTC(2026, 7, 9))), '09-08-2026');
    assert.equal(portalDate(new Date(Date.UTC(2026, 11, 31))), '31-12-2026');
  });

  it('writes the period MMYYYY, not ISO', () => {
    assert.equal(portalPeriod('2026-08'), '082026');
    assert.equal(portalPeriod('2027-01'), '012027');
  });
});
