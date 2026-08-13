/**
 * GSTR-1 as the GST portal's offline utility expects it.
 *
 * Field names are the portal's, not ours — `inum`, `txval`, `camt`, `rchrg`.
 * They are terse and unguessable, so each is named in a comment. Getting one
 * wrong means the upload is rejected, or worse, accepted with the wrong figure.
 *
 * Reference: the GSTN offline tool's JSON schema, version GST3.2. Amounts are
 * numbers here rather than strings, because that is what the schema demands —
 * the only place in this codebase where money becomes a float, and it happens
 * at the very last step, after every calculation is finished.
 */

/// Return period as MMYYYY — "082026" for August 2026. Not YYYY-MM.
export type ReturnPeriod = string;

export interface Gstr1ItemDetail {
  /// Combined GST rate as a number: 18, not "18%" and not 0.18.
  rt: number;
  /// Taxable value.
  txval: number;
  /// IGST amount.
  iamt: number;
  /// CGST amount.
  camt: number;
  /// SGST amount.
  samt: number;
  /// Cess amount.
  csamt: number;
}

export interface Gstr1Item {
  /// Serial number of the rate line within the invoice, from 1.
  num: number;
  itm_det: Gstr1ItemDetail;
}

export interface Gstr1Invoice {
  /// Invoice number, exactly as issued.
  inum: string;
  /// Invoice date, dd-mm-yyyy.
  idt: string;
  /// Invoice value including tax.
  val: number;
  /// Place of supply, 2-digit state code.
  pos: string;
  /// Reverse charge: "Y" or "N".
  rchrg: 'Y' | 'N';
  /**
   * Invoice type. "R" is a regular taxable supply, which is everything this
   * shop issues. SEZ, deemed exports and the rest have their own codes.
   */
  inv_typ: 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW';
  itms: Gstr1Item[];
}

/// B2B — supplies to a registered person, grouped by their GSTIN.
export interface Gstr1B2b {
  /// Counterparty GSTIN.
  ctin: string;
  inv: Gstr1Invoice[];
}

/**
 * B2CL — inter-state supplies to an unregistered person above the threshold,
 * reported invoice by invoice and grouped by place of supply.
 */
export interface Gstr1B2cl {
  pos: string;
  inv: Omit<Gstr1Invoice, 'pos' | 'rchrg' | 'inv_typ'>[];
}

/**
 * B2CS — everything else sold to unregistered persons, reported only as a
 * total per state per rate. No invoice detail leaves the shop.
 */
export interface Gstr1B2cs {
  /// "INTRA" or "INTER".
  sply_ty: 'INTRA' | 'INTER';
  pos: string;
  /// "OE" — other than e-commerce.
  typ: 'OE';
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface Gstr1Note {
  /// "C" for a credit note, "D" for a debit note.
  ntty: 'C' | 'D';
  nt_num: string;
  nt_dt: string;
  /// Note value including tax.
  val: number;
  pos: string;
  rchrg: 'Y' | 'N';
  /// Pre-GST supply. Always "N" here.
  p_gst: 'Y' | 'N';
  itms: Gstr1Item[];
}

/// CDNR — credit/debit notes issued to a registered person.
export interface Gstr1Cdnr {
  ctin: string;
  nt: Gstr1Note[];
}

/// CDNUR — notes to an unregistered person. Flat, with a supply-type code.
export interface Gstr1Cdnur {
  /// "B2CL" for a note against a large inter-state B2C invoice.
  typ: 'B2CL' | 'EXPWP' | 'EXPWOP';
  ntty: 'C' | 'D';
  nt_num: string;
  nt_dt: string;
  val: number;
  pos: string;
  itms: Gstr1Item[];
}

export interface Gstr1HsnRow {
  num: number;
  /// The HSN code itself.
  hsn_sc: string;
  desc: string;
  /// Unit Quantity Code — NOS, KGS, PAC.
  uqc: string;
  qty: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

/**
 * The document series issued in the period.
 *
 * This is what makes gap-free numbering auditable: the portal is told the range
 * issued and how many were cancelled, and the arithmetic has to work out.
 */
export interface Gstr1DocSeries {
  num: number;
  from: string;
  to: string;
  totnum: number;
  cancel: number;
  net_issue: number;
}

export interface Gstr1DocDetail {
  /// 1 = invoices for outward supply, 4 = debit notes, 5 = credit notes.
  doc_num: number;
  docs: Gstr1DocSeries[];
}

export interface Gstr1Return {
  /// The filer's own GSTIN.
  gstin: string;
  /// Filing period, MMYYYY.
  fp: ReturnPeriod;
  version: string;
  hash: string;
  b2b?: Gstr1B2b[];
  b2cl?: Gstr1B2cl[];
  b2cs?: Gstr1B2cs[];
  cdnr?: Gstr1Cdnr[];
  cdnur?: Gstr1Cdnur[];
  hsn?: { data: Gstr1HsnRow[] };
  doc_issue?: { doc_det: Gstr1DocDetail[] };
}

/**
 * A human-readable account of what went into the return, shown on screen
 * before anyone downloads anything.
 *
 * The JSON is unreadable by design; nobody can eyeball it for a missing
 * invoice. This is what makes the return checkable.
 */
export interface Gstr1Summary {
  period: string;
  periodLabel: string;
  gstin: string;
  counts: {
    b2bInvoices: number;
    b2bCounterparties: number;
    b2clInvoices: number;
    b2csRows: number;
    creditNotes: number;
    debitNotes: number;
    hsnRows: number;
    cancelledInvoices: number;
  };
  totals: {
    taxableValue: string;
    cgst: string;
    sgst: string;
    igst: string;
    cess: string;
    invoiceValue: string;
  };
  /**
   * Things a human should look at before filing. Not errors — the return is
   * still produced — but every one of them is a way a return goes wrong.
   */
  warnings: { code: string; message: string }[];
}
