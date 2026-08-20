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
import { allocateDocumentNumber, peekDocumentNumber, repairMissingPrefixes } from './numbering.js';
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

  /**
   * Repairing shops that were registered before the seed was completed.
   *
   * The bug is closed for new shops twice over — registration seeds every type
   * and `DEFAULT_PREFIXES` covers the lazy path — but neither reaches a series
   * row that already exists. This is the only way an affected shop gets its
   * prefix back, and since it writes to live data it is worth more care than
   * most maintenance code.
   */
  describe('repairing a series created without a prefix', () => {
    /**
     * Exactly what the lazy path used to produce, before the defaults existed.
     *
     * Upserted rather than created, because the test factory seeds every
     * series — which is itself how the production gap stayed hidden for so
     * long: the fixture was more complete than registration.
     */
    async function damage(documentType: 'PURCHASE_INVOICE' | 'PAYMENT_VOUCHER', issued = 0) {
      return prisma.numberSequence.upsert({
        where: {
          businessId_documentType_financialYear: {
            businessId: ctx.businessId,
            documentType,
            financialYear: fy,
          },
        },
        create: {
          businessId: ctx.businessId,
          documentType,
          financialYear: fy,
          prefix: '',
          padding: 4,
          nextNumber: issued + 1,
        },
        update: { prefix: '', padding: 4, nextNumber: issued + 1 },
      });
    }

    it('reports what it would change and writes nothing without --apply', async () => {
      const series = await damage('PURCHASE_INVOICE');

      const found = await repairMissingPrefixes(prisma);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.documentType, 'PURCHASE_INVOICE');
      assert.equal(found[0]!.prefix, 'PUR/');

      const untouched = await prisma.numberSequence.findUnique({ where: { id: series.id } });
      assert.equal(untouched!.prefix, '', 'a dry run must not write');
    });

    it('restores the prefix so the next number is numbered properly', async () => {
      await damage('PURCHASE_INVOICE');

      await repairMissingPrefixes(prisma, { apply: true });

      const next = await prisma.$transaction((tx) =>
        allocateDocumentNumber(tx, ctx.businessId, 'PURCHASE_INVOICE', fy),
      );
      assert.equal(next.number, 'PUR/0001');
    });

    it('leaves numbers already issued alone, and says how many', async () => {
      // The live case: one bill went out as "0001" before anyone noticed.
      await damage('PURCHASE_INVOICE', 1);

      const [repair] = await repairMissingPrefixes(prisma, { apply: true });
      assert.equal(repair!.alreadyIssued, 1);

      // The prefix applies from the *next* number. 0001 keeps its bare form,
      // because a number that has gone out is never rewritten.
      const next = await prisma.$transaction((tx) =>
        allocateDocumentNumber(tx, ctx.businessId, 'PURCHASE_INVOICE', fy),
      );
      assert.equal(next.number, 'PUR/0002');
    });

    it('never overwrites a prefix somebody chose on purpose', async () => {
      await prisma.numberSequence.updateMany({
        where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
        data: { prefix: 'MPH/' },
      });

      const repairs = await repairMissingPrefixes(prisma, { apply: true });
      assert.equal(
        repairs.some((r) => r.documentType === 'SALES_INVOICE'),
        false,
      );

      const kept = await prisma.numberSequence.findFirst({
        where: { businessId: ctx.businessId, documentType: 'SALES_INVOICE' },
      });
      assert.equal(kept!.prefix, 'MPH/');
    });

    it('finds nothing on a shop registered after the fix', async () => {
      assert.deepEqual(await repairMissingPrefixes(prisma), []);
    });
  });
});
