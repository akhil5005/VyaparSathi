/**
 * Invoice numbering against a real Postgres.
 *
 * GST requires document numbers to be unique and gap-free within a financial
 * year. Both properties depend on a row lock that only a real database can
 * demonstrate — this is the file that proves the `{ increment: 1 }` inside a
 * transaction actually serialises.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { createTestBusiness, type TestContext } from '../../test-support/factories.js';
import { allocateDocumentNumber, peekDocumentNumber } from './numbering.js';
import { currentFinancialYear } from '../../lib/financialYear.js';

describe('document numbering (integration)', () => {
  let ctx: TestContext;
  const fy = currentFinancialYear();

  before(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestBusiness();
  });

  after(async () => {
    await disconnect();
  });

  it('allocates sequentially with the configured prefix and padding', async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await prisma.$transaction((tx) =>
        allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
      );
      numbers.push(result.number);
    }

    assert.deepEqual(numbers, ['INV/0001', 'INV/0002', 'INV/0003']);
  });

  it('peeking does not consume a number', async () => {
    const peeked = await peekDocumentNumber(prisma, ctx.businessId, 'SALES_INVOICE', fy);
    assert.equal(peeked, 'INV/0001');

    const allocated = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
    );
    assert.equal(allocated.number, 'INV/0001');
  });

  it('hands out distinct numbers under concurrency', async () => {
    // The real test. Twenty transactions racing for the same sequence row: if
    // the lock is not held for the transaction's lifetime, two of them read the
    // same value and produce a duplicate invoice number.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction((tx) =>
          allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
        ),
      ),
    );

    const numbers = results.map((r) => r.number);
    assert.equal(new Set(numbers).size, 20, `duplicates issued: ${numbers.join(', ')}`);

    // And gap-free: exactly 1..20, in some order.
    const values = results.map((r) => r.sequenceValue).sort((a, b) => a - b);
    assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('returns the number to the pool when the transaction rolls back', async () => {
    // Gap-free means a failed invoice must not burn its number.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy);
        throw new Error('simulated failure after allocation');
      }),
      /simulated failure/,
    );

    const next = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
    );
    assert.equal(next.number, 'INV/0001');
  });

  it('keeps separate series per document type', async () => {
    const invoice = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
    );
    const purchase = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'PURCHASE_INVOICE', fy),
    );

    assert.equal(invoice.number, 'INV/0001');
    assert.equal(purchase.number, 'PUR/0001');
  });

  it('starts a fresh series in a new financial year, carrying the format forward', async () => {
    await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
    );

    const nextYear = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', '2099-00'),
    );

    // New year restarts at 1 but keeps the prefix and padding from last year.
    assert.equal(nextYear.number, 'INV/0001');
    assert.equal(nextYear.sequenceValue, 1);
  });

  it('rejects a number longer than the 16 characters GST allows', async () => {
    await prisma.numberSequence.updateMany({
      where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
      data: { prefix: 'VERY-LONG-PREFIX/', suffix: '/26-27' },
    });

    await assert.rejects(
      prisma.$transaction((tx) =>
        allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
      ),
      /maximum of 16/,
    );
  });

  it('isolates sequences between businesses', async () => {
    const other = await createTestBusiness({ gstin: '03AAACT2727Q1ZX' });

    const a = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, ctx.businessId, 'SALES_INVOICE', fy),
    );
    const b = await prisma.$transaction((tx) =>
      allocateDocumentNumber(tx, other.businessId, 'SALES_INVOICE', fy),
    );

    assert.equal(a.number, 'INV/0001');
    assert.equal(b.number, 'INV/0001');
  });
});
