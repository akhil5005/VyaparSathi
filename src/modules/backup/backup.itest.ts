/**
 * Backup and restore, round trip.
 *
 * The only test that matters for a backup is whether the books come back. So
 * this builds a shop with real history — invoices, a credit note, a purchase, a
 * payment against a bill, stock movements, a ledger — exports it, wipes the
 * database to the floor, restores from the file alone, and then checks the
 * figures still reconcile.
 *
 * Anything less proves the export produced *a* file, not a usable one.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { createPurchase } from '../purchases/purchase.service.js';
import { createNote } from '../notes/creditNote.service.js';
import { recordPayment } from '../payments/payment.service.js';
import { exportBusiness, backupSummary, BACKUP_FORMAT, BACKUP_VERSION } from './backup.service.js';
import { parseBackup, restoreBackup, RestoreError } from './restore.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });
const NEW_PASSWORD = 'a-restored-owner-password';

/** A backup as it actually travels: through JSON and back. */
const roundTripped = (backup: unknown) => parseBackup(JSON.parse(JSON.stringify(backup)));

describe('backup and restore (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  /** A shop with enough history that a broken restore cannot hide. */
  async function tradeForAWhile() {
    const { ctx, customer, supplier, product } = scenario;

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 10, rate: 250 }] },
      ctxOf(),
    );

    await createPurchase(
      ctx.businessId,
      ctx.userId,
      {
        partyId: supplier.id,
        supplierInvoiceNumber: 'JK/771',
        supplierInvoiceDate: new Date(),
        items: [{ productId: product.id, quantity: 40, unitId: ctx.unitIds.ream, rate: 200 }],
      },
      ctxOf(),
    );

    await createNote(
      ctx.businessId,
      ctx.userId,
      {
        noteType: 'CREDIT_NOTE',
        againstSalesInvoiceId: invoice.id,
        reason: 'DAMAGED_GOODS',
        items: [{ invoiceItemId: invoice.items[0]!.id, quantity: 2 }],
      },
      ctxOf(),
    );

    await recordPayment(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        direction: 'RECEIPT',
        amount: '1000',
        mode: 'CASH',
        allocations: [{ invoiceId: invoice.id, amount: '1000' }],
      },
      ctxOf(),
    );

    return invoice;
  }

  it('brings the whole shop back after the database is wiped', async () => {
    const { ctx, customer } = scenario;
    const invoice = await tradeForAWhile();

    const before = {
      business: await prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId } }),
      invoice: await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } }),
      balance: await prisma.partyBalance.findUniqueOrThrow({ where: { partyId: customer.id } }),
      stock: await prisma.productStock.findFirstOrThrow({
        where: { productId: scenario.product.id },
      }),
      ledgerCount: await prisma.ledgerEntry.count({ where: { businessId: ctx.businessId } }),
      movementCount: await prisma.stockMovement.count({ where: { businessId: ctx.businessId } }),
      sequence: await prisma.numberSequence.findFirstOrThrow({
        where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
      }),
    };

    const backup = roundTripped(await exportBusiness(ctx.businessId));

    // The disaster.
    await resetDatabase();
    assert.equal(await prisma.business.count(), 0);

    const result = await restoreBackup(prisma, backup, { ownerPassword: NEW_PASSWORD });
    assert.equal(result.businessId, ctx.businessId);

    const after = {
      business: await prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId } }),
      invoice: await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } }),
      balance: await prisma.partyBalance.findUniqueOrThrow({ where: { partyId: customer.id } }),
      stock: await prisma.productStock.findFirstOrThrow({
        where: { productId: scenario.product.id },
      }),
      ledgerCount: await prisma.ledgerEntry.count({ where: { businessId: ctx.businessId } }),
      movementCount: await prisma.stockMovement.count({ where: { businessId: ctx.businessId } }),
      sequence: await prisma.numberSequence.findFirstOrThrow({
        where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
      }),
    };

    assert.equal(after.business.gstin, before.business.gstin);
    assert.equal(after.invoice.invoiceNumber, before.invoice.invoiceNumber);
    assert.equal(after.invoice.grandTotal.toString(), before.invoice.grandTotal.toString());
    assert.equal(after.invoice.amountPaid.toString(), before.invoice.amountPaid.toString());

    // The two numbers the shop is actually run on.
    assert.equal(after.balance.currentBalance.toString(), before.balance.currentBalance.toString());
    assert.equal(after.stock.quantityOnHand.toString(), before.stock.quantityOnHand.toString());
    assert.equal(
      after.stock.avgCostPerBaseUnit.toString(),
      before.stock.avgCostPerBaseUnit.toString(),
    );

    assert.equal(after.ledgerCount, before.ledgerCount);
    assert.equal(after.movementCount, before.movementCount);

    // The next bill must not reuse a number that has already been given out.
    assert.equal(after.sequence.nextNumber, before.sequence.nextNumber);
  });

  it('keeps billing correctly after a restore, without reusing an invoice number', async () => {
    const { ctx, customer, product } = scenario;
    await tradeForAWhile();

    const backup = roundTripped(await exportBusiness(ctx.businessId));
    await resetDatabase();
    await restoreBackup(prisma, backup, { ownerPassword: NEW_PASSWORD });

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: customer.id, items: [{ productId: product.id, quantity: 1, rate: 250 }] },
      ctxOf(),
    );

    // INV/0001 was issued before the wipe; the restored sequence continues.
    assert.equal(invoice.invoiceNumber, 'INV/0002');
  });

  it('never writes a password hash, a session or a reset token into the file', async () => {
    const { ctx } = scenario;
    await tradeForAWhile();

    const hash = (
      await prisma.user.findFirstOrThrow({ where: { businessId: ctx.businessId } })
    ).passwordHash;

    const backup = await exportBusiness(ctx.businessId);
    const text = JSON.stringify(backup);

    // The file lands in a Downloads folder and gets emailed around. Credential
    // material must not travel with it.
    assert.ok(!text.includes(hash), 'the password hash is in the backup file');
    assert.ok(!text.includes('passwordHash'), 'the passwordHash key is in the backup file');
    assert.ok(!text.includes('totpSecret'));
    assert.ok(!('sessions' in backup));
    assert.ok(!('passwordResetTokens' in backup));

    // But the user itself must survive, or their invoices lose their author.
    assert.equal(backup.users.length, 1);
    assert.equal(backup.users[0]!.id, ctx.userId);
  });

  it('lets the restored owner sign in with the new password, and only that one', async () => {
    const { ctx } = scenario;
    await tradeForAWhile();
    const backup = roundTripped(await exportBusiness(ctx.businessId));

    const oldHash = (
      await prisma.user.findFirstOrThrow({ where: { businessId: ctx.businessId, role: 'OWNER' } })
    ).passwordHash;

    await resetDatabase();
    const result = await restoreBackup(prisma, backup, { ownerPassword: NEW_PASSWORD });

    const owner = await prisma.user.findFirstOrThrow({
      where: { businessId: ctx.businessId, role: 'OWNER' },
    });

    assert.ok(result.ownerIdentifier);
    assert.notEqual(owner.passwordHash, oldHash);
    const { verifyPassword } = await import('../../lib/password.js');
    assert.equal(await verifyPassword(owner.passwordHash, NEW_PASSWORD), true);
  });

  it('refuses to restore on top of a shop that is already there', async () => {
    const { ctx } = scenario;
    await tradeForAWhile();
    const backup = roundTripped(await exportBusiness(ctx.businessId));

    // Nothing wiped — the books are live.
    await assert.rejects(
      restoreBackup(prisma, backup, { ownerPassword: NEW_PASSWORD }),
      (error: unknown) => error instanceof RestoreError && /already in this database/.test((error as Error).message),
    );

    // And it left the live data completely alone.
    assert.equal(await prisma.salesInvoice.count({ where: { businessId: ctx.businessId } }), 1);
  });

  it('refuses a file that is not a backup, or is from a newer format', async () => {
    assert.throws(() => parseBackup({ hello: 'world' }), RestoreError);
    assert.throws(
      () => parseBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, business: {} }),
      /version/,
    );
  });

  it('refuses a password too short to be worth setting', async () => {
    const { ctx } = scenario;
    const backup = roundTripped(await exportBusiness(ctx.businessId));
    await resetDatabase();

    await assert.rejects(
      restoreBackup(prisma, backup, { ownerPassword: 'short' }),
      RestoreError,
    );
  });

  it('summarises what is in the file without producing it', async () => {
    const { ctx } = scenario;
    await tradeForAWhile();

    const summary = await backupSummary(ctx.businessId);

    assert.equal(summary.counts.salesInvoices, 1);
    assert.equal(summary.counts.purchaseInvoices, 1);
    assert.equal(summary.counts.notes, 1);
    assert.equal(summary.counts.payments, 1);
    assert.equal(summary.counts.parties, 2);
    assert.ok(summary.counts.ledgerEntries > 0);
    assert.equal(summary.latestInvoice?.number, 'INV/0001');
  });

  it('never carries another shop into the file', async () => {
    const { ctx } = scenario;
    await tradeForAWhile();

    const other = await setupBillingScenario();
    await createSalesInvoice(
      other.ctx.businessId,
      other.ctx.userId,
      { partyId: other.customer.id, items: [{ productId: other.product.id, quantity: 5, rate: 900 }] },
      ctxOf(),
    );

    const backup = await exportBusiness(ctx.businessId);

    assert.equal(backup.salesInvoices.length, 1);
    assert.equal(backup.parties.length, 2);
    assert.ok(!JSON.stringify(backup).includes(other.ctx.businessId));
  });
});
