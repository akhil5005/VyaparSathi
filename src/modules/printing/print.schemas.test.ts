import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrinterSchema,
  invoicePdfQuerySchema,
  receiptQuerySchema,
  updatePrinterSchema,
} from './print.schemas.js';

describe('boolean flags from a query string', () => {
  // The trap this pins: `z.coerce.boolean()` is `Boolean(value)`, so the string
  // "false" — exactly what `?preview=false` sends — comes out `true`, and a
  // preview would silently increment the invoice's print count.
  it('reads "false" as false, not as a truthy string', () => {
    assert.equal(invoicePdfQuerySchema.parse({ preview: 'false' }).preview, false);
    assert.equal(invoicePdfQuerySchema.parse({ download: 'false' }).download, false);
    assert.equal(receiptQuerySchema.parse({ showBalance: 'false' }).showBalance, false);
  });

  it('reads "true" as true', () => {
    assert.equal(invoicePdfQuerySchema.parse({ preview: 'true' }).preview, true);
  });

  it('leaves an absent flag undefined so the caller can pick the default', () => {
    assert.equal(invoicePdfQuerySchema.parse({}).preview, undefined);
  });

  it('accepts a real JSON boolean from a request body', () => {
    assert.equal(receiptQuerySchema.parse({ showBalance: true }).showBalance, true);
    assert.equal(receiptQuerySchema.parse({ showBalance: false }).showBalance, false);
  });
});

describe('printer profile schemas', () => {
  it('accepts a minimal profile', () => {
    assert.deepEqual(createPrinterSchema.parse({ name: 'Counter' }), { name: 'Counter' });
  });

  it('trims the name and rejects an empty one', () => {
    assert.equal(createPrinterSchema.parse({ name: '  Counter  ' }).name, 'Counter');
    assert.throws(() => createPrinterSchema.parse({ name: '   ' }));
  });

  it('coerces a port from a query string and bounds it to the TCP range', () => {
    assert.equal(createPrinterSchema.parse({ name: 'x', port: '9100' }).port, 9100);
    assert.throws(() => createPrinterSchema.parse({ name: 'x', port: 0 }));
    assert.throws(() => createPrinterSchema.parse({ name: 'x', port: 70000 }));
  });

  it('bounds characters per line to something a roll can actually be', () => {
    assert.throws(() => createPrinterSchema.parse({ name: 'x', charactersPerLine: 10 }));
    assert.throws(() => createPrinterSchema.parse({ name: 'x', charactersPerLine: 200 }));
    assert.equal(createPrinterSchema.parse({ name: 'x', charactersPerLine: 32 }).charactersPerLine, 32);
  });

  it('rejects an unknown paper width or connection', () => {
    assert.throws(() => createPrinterSchema.parse({ name: 'x', paperWidth: 'MM_57' }));
    assert.throws(() => createPrinterSchema.parse({ name: 'x', connection: 'PARALLEL' }));
  });

  it('caps copies — nobody wants six identical receipts by typo', () => {
    assert.throws(() => createPrinterSchema.parse({ name: 'x', copies: 6 }));
  });

  it('lets an update change only isActive', () => {
    assert.deepEqual(updatePrinterSchema.parse({ isActive: false }), { isActive: false });
  });
});

describe('receipt query', () => {
  it('bounds an explicit width override', () => {
    assert.equal(receiptQuerySchema.parse({ width: '32' }).width, 32);
    assert.throws(() => receiptQuerySchema.parse({ width: 8 }));
  });
});

describe('invoice pdf query', () => {
  it('accepts only the three statutory copies', () => {
    assert.equal(invoicePdfQuerySchema.parse({ copy: 'DUPLICATE' }).copy, 'DUPLICATE');
    assert.throws(() => invoicePdfQuerySchema.parse({ copy: 'QUADRUPLICATE' }));
  });
});
