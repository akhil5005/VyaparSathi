/**
 * Response shapes from the API.
 *
 * Hand-written rather than generated. The API sends every money and quantity
 * value as a **string**, because Postgres NUMERIC does not fit in a JavaScript
 * number without losing paise — 0.1 + 0.2 is not 0.3, and an invoice that is
 * out by a paisa is a filing problem. Typing them as `string` here is what stops
 * someone innocently writing `a + b` and shipping a rounding bug.
 */

export type Money = string;
export type Quantity = string;
export type IsoDate = string;

export type UserRole = 'OWNER' | 'MANAGER' | 'BILLING_STAFF' | 'ACCOUNTANT' | 'VIEWER';
export type PartyType = 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CANCELLED';
export type SupplyType = 'INTRA_STATE' | 'INTER_STATE';
export type PaymentMode = 'CASH' | 'UPI' | 'CHEQUE' | 'BANK_TRANSFER' | 'NEFT_RTGS' | 'CARD' | 'ADJUSTMENT';
export type PaymentDirection = 'RECEIPT' | 'PAYMENT';

export interface User {
  id: string;
  fullName: string;
  email: string | null;
  phone: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: IsoDate | null;
}

/**
 * The business as every auth response sends it.
 *
 * Kept in step with `PUBLIC_BUSINESS_SELECT` on the server, which is the single
 * `select` shared by register, login and `/me`. Those three used to select
 * different fields — login omitted the state code — so this type was true of
 * one response and a lie about another. An HTTP test now asserts all three
 * against the same key list.
 */
export interface Business {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string;
  stateCode: string;
  stateName: string;
  city: string;
  phone: string;
  gstRegistrationType: string;
  fyStartMonth: number;
  hsnDigits: number;
  isActive: boolean;
}

export interface AuthResponse {
  user: User;
  business: Business;
  accessToken: string;
  refreshToken: string;
}

export interface Unit {
  id: string;
  name: string;
  symbol: string;
  uqc: string;
  allowDecimal: boolean;
  isActive: boolean;
}

export interface HsnCode {
  id: string;
  code: string;
  description: string;
  taxRates?: HsnTaxRate[];
  /// The rate in force today, or null if none applies — a product on an HSN
  /// with no current rate cannot be billed.
  currentRate?: HsnTaxRate | null;
  productCount?: number;
}

export interface Party {
  id: string;
  displayName: string;
  legalName: string | null;
  partyType: PartyType;
  gstin: string | null;
  stateCode: string;
  stateName: string;
  phone: string | null;
  city: string | null;
  creditLimit: Money | null;
  creditDays: number | null;
  isActive: boolean;
  balance?: { currentBalance: Money } | null;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  hsnCodeId: string;
  hsnCode?: { code: string; description: string };
  baseUnitId: string;
  baseUnit?: Unit;
  gsm: number | null;
  sheetSize: string | null;
  sheetsPerReam: number | null;
  weightPerBaseUnitKg: string | null;
  defaultSaleRate: Money | null;
  /// What the mill last charged, in the purchase unit — usually per kg.
  defaultPurchaseRate: Money | null;
  defaultSaleUnitId: string | null;
  defaultPurchaseUnitId: string | null;
  reorderLevel: Money | null;
  isActive: boolean;
  stock?: { quantityOnHand: Quantity; avgCostPerBaseUnit: Money } | null;
  productUnits?: { unitId: string; unit?: Unit; conversionToBase: string; isSalesDefault: boolean }[];
}

export interface InvoiceItem {
  id: string;
  lineNumber: number;
  productId: string;
  productName: string;
  hsnCode: string;
  quantity: Quantity;
  unitId: string;
  unitName: string;
  uqc: string;
  rate: Money;
  discountPercent: Money;
  discountAmount: Money;
  taxableValue: Money;
  cgstRate: Money;
  cgstAmount: Money;
  sgstRate: Money;
  sgstAmount: Money;
  igstRate: Money;
  igstAmount: Money;
  cessRate: Money;
  cessAmount: Money;
  lineTotal: Money;
}

export interface InvoiceTotals {
  subtotal: Money;
  totalDiscount: Money;
  taxableValue: Money;
  totalCgst: Money;
  totalSgst: Money;
  totalIgst: Money;
  totalCess: Money;
  freightCharges: Money;
  otherCharges: Money;
  roundOff: Money;
  grandTotal: Money;
}

export interface SalesInvoice extends InvoiceTotals {
  id: string;
  invoiceNumber: string | null;
  financialYear: string;
  status: InvoiceStatus;
  invoiceDate: IsoDate;
  dueDate: IsoDate | null;
  partyId: string;
  partyName: string;
  partyGstin: string | null;
  partyStateCode: string;
  supplyType: SupplyType;
  placeOfSupply: string;
  amountPaid: Money;
  amountDue?: Money;
  amountInWords: string | null;
  items: InvoiceItem[];
  printedCount: number;
}

/** What `POST /api/sales-invoices/preview` returns — nothing is written. */
export interface InvoicePreview {
  totals: InvoiceTotals;
  lines: InvoiceItem[];
  supplyType: SupplyType;
  amountInWords: string;
  warnings?: string[];
}

/**
 * Field names here are transcribed from the live API, not guessed.
 *
 * An earlier version of this file invented `days30 / days60 / days90 / older`
 * for the ageing buckets and `string[]` for invoice warnings. Both compiled
 * perfectly and both were wrong — the warnings one crashed the billing screen.
 * A hand-written type is a claim about someone else's code, and the only way to
 * check it is against the real response.
 */
export interface Payment {
  id: string;
  voucherNumber: string;
  paymentDate: IsoDate;
  partyId: string;
  party?: { id: string; displayName: string };
  direction: PaymentDirection;
  amount: Money;
  mode: PaymentMode;
  /// Money taken but not yet applied to a bill — sits on the customer's account.
  unallocatedAmount: Money;
  referenceNumber: string | null;
  bankName: string | null;
  notes: string | null;
  chequeId: string | null;
  cheque?: Cheque | null;
  /// Null unless the payment was reversed; a reversal is never a deletion.
  reversedAt: IsoDate | null;
  reversedReason: string | null;
  createdAt: IsoDate;
  _count?: { allocations: number };
}

export interface PaymentListResponse {
  payments: Payment[];
  total: number;
  page: number;
  pageSize: number;
  totalAmount: Money;
  totalOnAccount: Money;
}

export type ChequeStatus = 'PENDING' | 'DEPOSITED' | 'CLEARED' | 'BOUNCED' | 'CANCELLED';

export interface Cheque {
  id: string;
  partyId: string;
  party?: { id: string; displayName: string; phone: string | null };
  direction: PaymentDirection;
  chequeNumber: string;
  bankName: string;
  branchName: string | null;
  /// The date written on the cheque, often weeks ahead — the whole reason
  /// cheques are tracked separately from the payment.
  chequeDate: IsoDate;
  amount: Money;
  status: ChequeStatus;
  depositedAt: IsoDate | null;
  clearedAt: IsoDate | null;
  bouncedAt: IsoDate | null;
  bounceReason: string | null;
  bounceCharges: Money | null;
  notes: string | null;
  /// Server-computed: the cheque date has arrived, so it can be banked today.
  bankable: boolean;
}

export interface ChequeListResponse {
  cheques: Cheque[];
  total: number;
  page: number;
  pageSize: number;
  totalAmount: Money;
}

/// Buckets as the server actually names them. `current` is 0–30 days.
export interface AgeingSummary {
  current: Money;
  days31to60: Money;
  days61to90: Money;
  over90: Money;
  total: Money;
}

export interface OutstandingParty {
  partyId: string;
  partyName: string;
  invoiceCount: number;
  ageing: AgeingSummary;
  oldestInvoiceDate: IsoDate;
  /// Only populated when the report is filtered to one party.
  invoices?: OutstandingInvoice[];
}

export interface OutstandingInvoice {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: IsoDate;
  dueDate: IsoDate | null;
  grandTotal: Money;
  amountPaid: Money;
  amountDue: Money;
}

export interface OutstandingResponse {
  asOf: IsoDate;
  parties: OutstandingParty[];
  grandTotal: AgeingSummary;
}

export interface PrinterProfile {
  id: string;
  name: string;
  paperWidth: 'MM_58' | 'MM_80' | 'A4' | 'A5';
  connection: 'USB' | 'NETWORK' | 'BLUETOOTH' | 'SYSTEM';
  ipAddress: string | null;
  port: number | null;
  charactersPerLine: number;
  cutAfterPrint: boolean;
  copies: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface Paginated<T> {
  page: number;
  pageSize: number;
  total: number;
  items?: T[];
}

// ---------------------------------------------------------------------------
// List endpoints. Each names its own array rather than a generic `items`, so
// they are spelled out here rather than squeezed into one shape.
// ---------------------------------------------------------------------------

/** `GET /api/masters/parties` — adds the ledger balance and a credit warning. */
export interface PartyListItem extends Party {
  currentBalance: Money;
  overCreditLimit: boolean;
}

export interface PartyListResponse {
  parties: PartyListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PartyRate {
  id: string;
  productId: string;
  unitId: string;
  rate: Money;
  effectiveFrom: IsoDate;
  product?: { id: string; name: string };
  unit?: { id: string; name: string; symbol: string };
}

/** `GET /api/masters/parties/:id` */
export interface PartyDetail extends Party {
  legalName: string | null;
  gstRegistrationType: string;
  pan: string | null;
  alternatePhone: string | null;
  whatsappNumber: string | null;
  email: string | null;
  contactPerson: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  pincode: string | null;
  openingBalance: Money;
  openingBalanceDate: IsoDate | null;
  notes: string | null;
  /**
   * Signed. **Positive means they owe us**; negative means we owe them, which
   * is the normal state for a supplier. Never render this as a bare number —
   * a minus sign in front of a rupee figure is read as a mistake, not as a
   * direction of debt.
   */
  currentBalance: Money;
  partyRates: PartyRate[];
  stats: {
    invoiceCount: number;
    totalBilled: Money;
    oldestUnpaidInvoice: IsoDate | null;
  };
}

/// One line of the party's account. Debit increases what they owe us.
export interface LedgerEntry {
  id: string;
  entryDate: IsoDate;
  voucherType: string;
  voucherId: string | null;
  voucherNumber: string | null;
  debit: Money;
  credit: Money;
  runningBalance: Money;
  narration: string | null;
  /**
   * When the row was written, as distinct from `entryDate`, which is the date
   * it is *accounted* on and can be backdated.
   *
   * `runningBalance` is computed at insert time, so this is the only ordering
   * in which that column is coherent — see the sort in PartyDetailDialog.
   */
  createdAt: IsoDate;
}

export interface PartyLedgerResponse {
  party: { id: string; displayName: string };
  entries: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalDebit: Money;
  totalCredit: Money;
  closingBalance: Money;
}

/** `GET /api/masters/products` — adds stock on hand and a reorder flag. */
export interface ProductListItem extends Product {
  quantityOnHand: Quantity;
  stockValue: Money;
  lowStock: boolean;
  hsnCode?: { code: string; description: string };
  baseUnit?: Unit;
}

export interface ProductListResponse {
  products: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HsnTaxRate {
  id: string;
  hsnCodeId: string;
  gstRate: Money;
  cessRate: Money;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  notes: string | null;
}

export interface ProductUnitRow {
  id: string;
  unitId: string;
  unit: Unit;
  /// Multiply a quantity in this unit by this to get base units.
  conversionToBase: string;
  isPurchaseDefault: boolean;
  isSalesDefault: boolean;
}

/**
 * `GET /api/masters/products/:id` — the list row plus everything needed to edit.
 *
 * `billable` is the server's own verdict on whether this can go on an invoice
 * at all: a product whose HSN has no rate in force on today's date cannot be
 * taxed, so it must not be sold until one is added.
 */
export interface ProductDetail extends ProductListItem {
  productUnits: ProductUnitRow[];
  currentTaxRate: HsnTaxRate | null;
  billable: boolean;
}

export type StockMovementType =
  | 'OPENING'
  | 'PURCHASE_IN'
  | 'SALE_OUT'
  | 'SALES_RETURN_IN'
  | 'PURCHASE_RETURN_OUT'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'DAMAGE_OUT';

/**
 * One line of the append-only stock ledger.
 *
 * `baseQuantity` is signed — negative for anything leaving — and `balanceAfter`
 * is the running total, so a disputed stock figure can be traced back movement
 * by movement rather than argued about.
 */
export interface StockMovement {
  id: string;
  productId: string;
  movementType: StockMovementType;
  movementDate: IsoDate;
  baseQuantity: Quantity;
  ratePerBaseUnit: Money | null;
  balanceAfter: Quantity;
  referenceType: string | null;
  referenceId: string | null;
  referenceNumber: string | null;
  notes: string | null;
  createdAt: IsoDate;
}

export interface StockHistoryResponse {
  product: { id: string; name: string };
  movements: StockMovement[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `GET /api/sales-invoices` — a deliberately slim row.
 *
 * The list endpoint does not send items or tax breakdowns; those come with the
 * detail. Worth knowing before writing a column that reads `invoice.items`.
 */
export interface SalesInvoiceListItem {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: IsoDate;
  dueDate: IsoDate | null;
  status: InvoiceStatus;
  partyId: string;
  partyName: string;
  supplyType: SupplyType;
  taxableValue: Money;
  grandTotal: Money;
  amountPaid: Money;
  amountDue: Money;
  createdViaVoice: boolean;
}

export interface SalesInvoiceListResponse {
  invoices: SalesInvoiceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HsnSummaryRow {
  hsnCode: string;
  uqc: string;
  quantity: Quantity;
  taxableValue: Money;
  cgstAmount: Money;
  sgstAmount: Money;
  igstAmount: Money;
  cessAmount: Money;
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  amount: Money;
  createdAt: IsoDate;
  payment?: {
    id: string;
    voucherNumber: string;
    paymentDate: IsoDate;
    mode: PaymentMode;
  };
}

/** `GET /api/sales-invoices/:id` — the whole document, as issued. */
export interface SalesInvoiceDetail extends SalesInvoice {
  partyAddress: string | null;
  partyPhone: string | null;
  reverseCharge: boolean;
  notes: string | null;
  transportName: string | null;
  vehicleNumber: string | null;
  issuedAt: IsoDate | null;
  cancelledAt: IsoDate | null;
  cancelledReason: string | null;
  /// Hidden from BILLING_STAFF by the server, so it may simply be absent.
  costOfGoods: Money | null;
  amountDue: Money;
  allocations: PaymentAllocation[];
  hsnSummary: HsnSummaryRow[];
}

// ---------------------------------------------------------------------------
// Credit and debit notes
// ---------------------------------------------------------------------------

export type NoteType = 'CREDIT_NOTE' | 'DEBIT_NOTE';

export type NoteReason =
  | 'SALES_RETURN'
  | 'PURCHASE_RETURN'
  | 'RATE_DIFFERENCE'
  | 'QUANTITY_SHORTAGE'
  | 'DAMAGED_GOODS'
  | 'POST_SALE_DISCOUNT'
  | 'CORRECTION'
  | 'OTHER';

/**
 * One line of an invoice, with how much of it is still creditable.
 *
 * `creditableQuantity` is the server's ceiling: invoiced minus everything
 * already credited across every earlier note. It is the number the quantity box
 * must be capped at, so a double return fails in the form rather than on submit.
 */
export interface CreditableLine {
  invoiceItemId: string;
  productId: string;
  productName: string;
  unitName: string;
  invoicedQuantity: Quantity;
  alreadyCredited: Quantity;
  creditableQuantity: Quantity;
  rate: Money;
}

export interface CreditableResponse {
  invoice: {
    id: string;
    invoiceNumber: string | null;
    invoiceDate: IsoDate;
    partyName: string;
  };
  lines: CreditableLine[];
}

export interface NoteLine {
  lineNumber: number;
  productName: string;
  hsnCode: string;
  quantity: Quantity;
  unitName: string;
  rate: Money;
  taxableValue: Money;
  cgstRate: Money;
  cgstAmount: Money;
  sgstRate: Money;
  sgstAmount: Money;
  igstRate: Money;
  igstAmount: Money;
  lineTotal: Money;
}

/** `POST /api/notes/preview` — full computation, nothing written. */
export interface NotePreviewResponse {
  noteType: NoteType;
  reason: NoteReason;
  /// Derived from the reason: a return moves goods back, a rate correction
  /// does not. The server decides; the screen only reports it.
  affectsStock: boolean;
  supplyType: SupplyType;
  party: { id: string; displayName: string };
  against: { number: string | null; date: IsoDate };
  lines: NoteLine[];
  totals: InvoiceTotals;
}

export interface CreditNote extends InvoiceTotals {
  id: string;
  noteNumber: string | null;
  noteType: NoteType;
  noteDate: IsoDate;
  status: InvoiceStatus;
  reason: NoteReason;
  reasonNote: string | null;
  partyId: string;
  partyName: string;
  affectsStock: boolean;
  againstSalesInvoiceId: string | null;
  againstPurchaseInvoiceId: string | null;
  party?: { id: string; displayName: string };
}

export interface NoteListResponse {
  notes: CreditNote[];
  total: number;
  page: number;
  pageSize: number;
  totalValue: Money;
  totalTaxable: Money;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

/**
 * A priced purchase line.
 *
 * The two fields that make this screen worth having are `chargeShare` — this
 * line's slice of the freight — and `landedCostPerBaseUnit`, what a unit
 * actually cost once freight is spread over the bill and reclaimable GST is
 * taken back out. Buying 100 kg at ₹95 is 42.76 reams at ₹233.86 landed, and
 * that is the number to compare against the ₹240 sale price.
 */
export interface PurchaseLine {
  lineNumber: number;
  productName: string;
  hsnCode: string;
  quantity: Quantity;
  unitName: string;
  /// Converted into the product's stock unit — kg billed, reams stocked.
  baseQuantity: Quantity;
  rate: Money;
  chargeShare: Money;
  landedCostPerBaseUnit: Money;
  grossAmount: Money;
  discountAmount: Money;
  discountPercent: Money;
  taxableValue: Money;
  cgstRate: Money;
  cgstAmount: Money;
  sgstRate: Money;
  sgstAmount: Money;
  igstRate: Money;
  igstAmount: Money;
  cessRate: Money;
  cessAmount: Money;
  lineTotal: Money;
}

export interface PurchasePreviewResponse {
  supplyType: SupplyType;
  party: { id: string; displayName: string; gstin: string | null; stateCode: string };
  lines: PurchaseLine[];
  totals: InvoiceTotals;
  itcEligible: boolean;
  /// Total GST reclaimable on this bill, or "0" when it is not eligible.
  inputTaxCredit: Money;
  /// Only present when a supplier total was typed in to check against.
  reconciliation?: { matches: boolean; difference: Money };
  warnings?: IssueWarning[];
}

export interface PurchaseInvoice extends InvoiceTotals {
  id: string;
  purchaseNumber: string | null;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: IsoDate;
  status: InvoiceStatus;
  partyId: string;
  partyName: string;
  partyGstin: string | null;
  supplyType: SupplyType;
  itcEligible: boolean;
  itcClaimed: boolean;
  itcClaimedPeriod: string | null;
  party?: { id: string; displayName: string };
}

export interface PurchaseListResponse {
  purchases: PurchaseInvoice[];
  total: number;
  page: number;
  pageSize: number;
  totalValue: Money;
  totalTaxable: Money;
}

/// The four heads credit is tracked under. CGST and SGST cannot offset each
/// other, which is why they are never summed into one figure.
export interface TaxHeads {
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
}

export interface PendingItcResponse {
  purchases: PurchaseInvoice[];
  count: number;
  heads: TaxHeads;
  totalCredit: Money;
}

/** `GET /api/masters/products/:id/kg-conversion` — the derived reams↔kg factor. */
export interface KgConversion {
  available: boolean;
  weightPerBaseUnitKg?: string;
  conversionToBase?: string;
  /// Plain-English working, e.g. "One ream weighs 2.3389 kg, so 1 kg = 0.4276 ream."
  explanation?: string;
  reason?: string;
}

/// A preview line carries the product and unit names resolved by the server,
/// so the screen never has to guess which unit a quantity was priced in.
export interface PreviewLine extends InvoiceItem {
  baseQuantity: Quantity;
}

/**
 * A non-blocking caution from the server — stock going negative, a customer
 * over their credit limit, an interstate supply needing an e-way bill.
 *
 * An **object**, not a string. Getting this wrong crashed the billing screen:
 * rendering `{warning}` put an object where React wanted a node, and because
 * `PARTY_UNREGISTERED` fires for any customer without a GSTIN, it happened on
 * the first realistic bill.
 */
export interface IssueWarning {
  code:
    | 'NEGATIVE_STOCK'
    | 'EWAY_BILL_REQUIRED'
    | 'PARTY_UNREGISTERED'
    | 'CREDIT_LIMIT_EXCEEDED'
    | (string & {});
  message: string;
}

/** `POST /api/sales-invoices/preview` — full computation, nothing written. */
export interface PreviewResponse {
  supplyType: SupplyType;
  party: { id: string; displayName: string; gstin: string | null; stateCode: string };
  lines: PreviewLine[];
  totals: InvoiceTotals;
  amountInWords: string;
  warnings?: IssueWarning[];
}

export interface CreateInvoiceResponse {
  invoice: SalesInvoice;
  warnings?: IssueWarning[];
}
