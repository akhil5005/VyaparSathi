import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';

/**
 * A complete copy of one shop's data, as a single JSON file.
 *
 * Why this exists at all: the books are the business. A hard disk dies, a
 * hosting account lapses, a free database tier is reclaimed — and eight years
 * of ledger goes with it. A `pg_dump` is the better disaster-recovery tool and
 * is documented alongside this, but it needs a shell, a Postgres client and a
 * connection string. This needs a button, which means it will actually happen.
 *
 * What it is *not*: a point-in-time snapshot of a live database. Rows are read
 * across several queries, so a bill issued mid-export could land half in and
 * half out. Take it when the counter is quiet, and treat it as "yesterday's
 * books", not "this instant".
 *
 * What is deliberately left out:
 *   - password hashes, TOTP secrets and recovery codes
 *   - sessions, refresh tokens, password-reset tokens
 *   - login attempts
 *
 * All of that is credential material, and this file ends up in a Downloads
 * folder, on a pen drive, or attached to an email. A backup that leaks logins
 * is worse than no backup. Restoring therefore sets a fresh owner password;
 * see `scripts/restore-backup.ts`.
 */

/// Bumped whenever the shape changes, so a restore can refuse a file it does
/// not understand rather than half-importing it.
export const BACKUP_FORMAT = 'vyapar-sathi-backup';
export const BACKUP_VERSION = 1;

/** Everything in one shop, in an order a restore can insert without breaking foreign keys. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /// Enough to identify the file without opening it fully.
  business: Record<string, unknown>;
  users: Record<string, unknown>[];
  units: Record<string, unknown>[];
  hsnCodes: Record<string, unknown>[];
  hsnTaxRates: Record<string, unknown>[];
  parties: Record<string, unknown>[];
  partyBalances: Record<string, unknown>[];
  partyRates: Record<string, unknown>[];
  products: Record<string, unknown>[];
  productUnits: Record<string, unknown>[];
  productStock: Record<string, unknown>[];
  numberSequences: Record<string, unknown>[];
  salesInvoices: Record<string, unknown>[];
  salesInvoiceItems: Record<string, unknown>[];
  purchaseInvoices: Record<string, unknown>[];
  purchaseInvoiceItems: Record<string, unknown>[];
  creditDebitNotes: Record<string, unknown>[];
  creditDebitNoteItems: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  paymentAllocations: Record<string, unknown>[];
  cheques: Record<string, unknown>[];
  ledgerEntries: Record<string, unknown>[];
  stockMovements: Record<string, unknown>[];
  ewayBills: Record<string, unknown>[];
  printerProfiles: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
}

/**
 * Fields never written to the file.
 *
 * Listed as a subtraction from `findMany()` rather than a hand-written select,
 * because a select would silently stop exporting any column added later — and
 * a backup that quietly drops a new field is the worst kind of backup.
 */
const USER_SECRETS = ['passwordHash', 'totpSecret', 'recoveryCodes'] as const;

const withoutSecrets = <T extends Record<string, unknown>>(user: T): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...user };
  for (const key of USER_SECRETS) delete copy[key];
  return copy;
};

export async function exportBusiness(businessId: string): Promise<BackupFile> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business not found');

  // Ids collected as the tenant's rows are read, so child tables can be
  // fetched by parent rather than by a businessId they do not carry.
  const [users, units, hsnCodes, parties, products, numberSequences] = await Promise.all([
    prisma.user.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.unit.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.hsnCode.findMany({ where: { businessId }, orderBy: { code: 'asc' } }),
    prisma.party.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.product.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.numberSequence.findMany({ where: { businessId } }),
  ]);

  const hsnCodeIds = hsnCodes.map((row) => row.id);
  const partyIds = parties.map((row) => row.id);
  const productIds = products.map((row) => row.id);

  const [hsnTaxRates, partyBalances, partyRates, productUnits, productStock] = await Promise.all([
    prisma.hsnTaxRate.findMany({ where: { hsnCodeId: { in: hsnCodeIds } } }),
    prisma.partyBalance.findMany({ where: { partyId: { in: partyIds } } }),
    prisma.partyRate.findMany({ where: { partyId: { in: partyIds } } }),
    prisma.productUnit.findMany({ where: { productId: { in: productIds } } }),
    prisma.productStock.findMany({ where: { productId: { in: productIds } } }),
  ]);

  const [salesInvoices, purchaseInvoices, creditDebitNotes, payments] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.purchaseInvoice.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.creditDebitNote.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.payment.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const salesInvoiceIds = salesInvoices.map((row) => row.id);
  const purchaseInvoiceIds = purchaseInvoices.map((row) => row.id);
  const noteIds = creditDebitNotes.map((row) => row.id);
  const paymentIds = payments.map((row) => row.id);

  const [
    salesInvoiceItems,
    purchaseInvoiceItems,
    creditDebitNoteItems,
    paymentAllocations,
    cheques,
    ledgerEntries,
    stockMovements,
    ewayBills,
    printerProfiles,
    auditLogs,
  ] = await Promise.all([
    prisma.salesInvoiceItem.findMany({ where: { invoiceId: { in: salesInvoiceIds } } }),
    prisma.purchaseInvoiceItem.findMany({ where: { invoiceId: { in: purchaseInvoiceIds } } }),
    prisma.creditDebitNoteItem.findMany({ where: { noteId: { in: noteIds } } }),
    prisma.paymentAllocation.findMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.cheque.findMany({ where: { businessId } }),
    prisma.ledgerEntry.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.stockMovement.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    prisma.ewayBill.findMany({ where: { businessId } }),
    prisma.printerProfile.findMany({ where: { businessId } }),
    prisma.auditLog.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
  ]);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    business,
    users: users.map(withoutSecrets),
    units,
    hsnCodes,
    hsnTaxRates,
    parties,
    partyBalances,
    partyRates,
    products,
    productUnits,
    productStock,
    numberSequences,
    salesInvoices,
    salesInvoiceItems,
    purchaseInvoices,
    purchaseInvoiceItems,
    creditDebitNotes,
    creditDebitNoteItems,
    payments,
    paymentAllocations,
    cheques,
    ledgerEntries,
    stockMovements,
    ewayBills,
    printerProfiles,
    auditLogs,
  } as BackupFile;
}

/**
 * What is in the file, without downloading it.
 *
 * Shown on the settings screen so the owner can see the backup is not empty
 * before trusting it — a zero-byte backup discovered on the day it is needed
 * is the classic failure.
 */
export async function backupSummary(businessId: string) {
  const [
    users,
    parties,
    products,
    salesInvoices,
    purchaseInvoices,
    notes,
    payments,
    ledgerEntries,
    stockMovements,
    latestInvoice,
  ] = await Promise.all([
    prisma.user.count({ where: { businessId } }),
    prisma.party.count({ where: { businessId } }),
    prisma.product.count({ where: { businessId } }),
    prisma.salesInvoice.count({ where: { businessId } }),
    prisma.purchaseInvoice.count({ where: { businessId } }),
    prisma.creditDebitNote.count({ where: { businessId } }),
    prisma.payment.count({ where: { businessId } }),
    prisma.ledgerEntry.count({ where: { businessId } }),
    prisma.stockMovement.count({ where: { businessId } }),
    prisma.salesInvoice.findFirst({
      where: { businessId, status: 'ISSUED' },
      orderBy: { invoiceDate: 'desc' },
      select: { invoiceNumber: true, invoiceDate: true },
    }),
  ]);

  return {
    counts: {
      users,
      parties,
      products,
      salesInvoices,
      purchaseInvoices,
      notes,
      payments,
      ledgerEntries,
      stockMovements,
    },
    latestInvoice: latestInvoice
      ? { number: latestInvoice.invoiceNumber, date: latestInvoice.invoiceDate.toISOString() }
      : null,
  };
}
