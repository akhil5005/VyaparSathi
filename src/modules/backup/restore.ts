import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../lib/password.js';
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from './backup.service.js';

/**
 * Putting a backup back.
 *
 * A backup you have never restored is a hope, not a backup. This is the other
 * half, and it is covered by a round-trip test that exports a shop with
 * invoices, notes, payments and a ledger, restores it into an empty database
 * and checks the figures still reconcile.
 *
 * Two deliberate refusals, both because the alternative is silent corruption:
 *
 *   1. It will not restore over a business that is already there. Merging a
 *      snapshot into live books duplicates invoice numbers and leaves a ledger
 *      that no longer adds up.
 *
 *   2. It will not restore without a new owner password. The file carries no
 *      password hashes on purpose, so without one nobody could sign in to the
 *      restored shop at all.
 */

export class RestoreError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'RestoreError';
    if (hint !== undefined) this.hint = hint;
  }
}

/** Checks a parsed file is a backup this build understands. */
export function parseBackup(parsed: unknown): BackupFile {
  const backup = parsed as Partial<BackupFile> | null;

  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
    throw new RestoreError('That is not a Vyapar Sathi backup file.');
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new RestoreError(
      `That backup is version ${backup.version}, and this build reads version ${BACKUP_VERSION}.`,
      'Restore it with the version of the app that wrote it.',
    );
  }
  if (!backup.business || typeof backup.business !== 'object') {
    throw new RestoreError('That backup has no business in it.');
  }
  return backup as BackupFile;
}

/**
 * Insert order: parents before children, all the way down.
 *
 * Two of these are less obvious than they look, and both come from a real
 * foreign key rather than taste:
 *   - cheques before payments, because a payment points at its cheque
 *   - party rates after products, because a rate is per product and unit
 */
const TABLES: { key: keyof BackupFile; model: string }[] = [
  { key: 'users', model: 'user' },
  { key: 'units', model: 'unit' },
  { key: 'hsnCodes', model: 'hsnCode' },
  { key: 'hsnTaxRates', model: 'hsnTaxRate' },
  { key: 'parties', model: 'party' },
  { key: 'partyBalances', model: 'partyBalance' },
  { key: 'products', model: 'product' },
  { key: 'productUnits', model: 'productUnit' },
  { key: 'productStock', model: 'productStock' },
  { key: 'partyRates', model: 'partyRate' },
  { key: 'numberSequences', model: 'numberSequence' },
  { key: 'salesInvoices', model: 'salesInvoice' },
  { key: 'salesInvoiceItems', model: 'salesInvoiceItem' },
  { key: 'purchaseInvoices', model: 'purchaseInvoice' },
  { key: 'purchaseInvoiceItems', model: 'purchaseInvoiceItem' },
  { key: 'creditDebitNotes', model: 'creditDebitNote' },
  { key: 'creditDebitNoteItems', model: 'creditDebitNoteItem' },
  { key: 'cheques', model: 'cheque' },
  { key: 'payments', model: 'payment' },
  { key: 'paymentAllocations', model: 'paymentAllocation' },
  { key: 'ledgerEntries', model: 'ledgerEntry' },
  { key: 'stockMovements', model: 'stockMovement' },
  { key: 'ewayBills', model: 'ewayBill' },
  { key: 'printerProfiles', model: 'printerProfile' },
  { key: 'auditLogs', model: 'auditLog' },
];

/**
 * The hash restored users get, since the file carries none.
 *
 * Not a password — a value argon2 cannot parse. `verifyPassword` treats an
 * unparseable hash as a wrong password rather than an error, so every restored
 * staff member is simply locked out until the owner sets them a password from
 * Settings → Staff. The column is NOT NULL, so *something* has to go here; a
 * value nothing can ever match is the only safe something.
 */
export const NO_PASSWORD_SET = '!no-password-set-after-restore';

type AnyDelegate = {
  create(args: { data: unknown }): Promise<unknown>;
  createMany(args: { data: unknown[] }): Promise<{ count: number }>;
};

const delegateOf = (client: unknown, model: string): AnyDelegate => {
  const delegate = (client as Record<string, AnyDelegate | undefined>)[model];
  if (!delegate) {
    throw new RestoreError(`No such model "${model}" — the backup format and the schema disagree.`);
  }
  return delegate;
};

export interface RestoreResult {
  businessId: string;
  legalName: string;
  /// Rows written, by section — printed by the CLI and asserted by the test.
  inserted: Record<string, number>;
  /// Who to sign in as. Null when the backup somehow had no owner.
  ownerIdentifier: string | null;
}

export async function restoreBackup(
  prisma: PrismaClient,
  backup: BackupFile,
  options: { ownerPassword: string; onProgress?: (section: string, count: number) => void },
): Promise<RestoreResult> {
  if (options.ownerPassword.length < 10) {
    throw new RestoreError('The new owner password must be at least 10 characters.');
  }

  const business = backup.business as unknown as { id: string; gstin: string; legalName: string };

  const clash = await prisma.business.findFirst({
    where: { OR: [{ id: business.id }, { gstin: business.gstin }] },
    select: { legalName: true },
  });
  if (clash) {
    throw new RestoreError(
      `"${clash.legalName}" is already in this database.`,
      'Restoring on top of it would duplicate invoice numbers and break the ledger. Point DATABASE_URL at an empty database and run this again.',
    );
  }

  const inserted: Record<string, number> = {};

  await prisma.$transaction(
    async (tx) => {
      await delegateOf(tx, 'business').create({ data: business });
      inserted.business = 1;

      for (const { key, model } of TABLES) {
        let rows = backup[key] as Record<string, unknown>[] | undefined;
        if (!rows?.length) continue;

        // passwordHash is NOT NULL and deliberately absent from the file.
        if (key === 'users') {
          rows = rows.map((row) => ({ passwordHash: NO_PASSWORD_SET, ...row }));
        }

        const { count } = await delegateOf(tx, model).createMany({ data: rows });
        inserted[key] = count;
        options.onProgress?.(key, count);
      }
    },
    // Years of history is a lot of inserts, and the 5s default would abandon
    // the restore half-done — the worst possible outcome for this operation.
    { timeout: 300_000, maxWait: 30_000 },
  );

  const owner = await prisma.user.findFirst({
    where: { businessId: business.id, role: 'OWNER' },
    orderBy: { createdAt: 'asc' },
  });

  if (owner) {
    await prisma.user.update({
      where: { id: owner.id },
      data: {
        passwordHash: await hashPassword(options.ownerPassword),
        // Any access token minted against the old row is void; the restored
        // shop starts with no valid sessions at all.
        tokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  }

  return {
    businessId: business.id,
    legalName: business.legalName,
    inserted,
    ownerIdentifier: owner ? (owner.email ?? owner.phone) : null,
  };
}
