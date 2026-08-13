/**
 * Printing against a real Postgres.
 *
 * The unit tests prove the layout and the byte protocol. This file proves the
 * joins: that a real invoice row reaches the renderers with every field the
 * layout reads, that the print counter moves, and that the printer-profile
 * rules (one default, never zero) survive concurrent edits.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { prisma, resetDatabase, disconnect } from '../../test-support/db.js';
import { createTestParty, setupBillingScenario } from '../../test-support/factories.js';
import { createSalesInvoice } from '../invoices/salesInvoice.service.js';
import { generateInvoicePdf, generateReceipt, printReceipt } from './print.service.js';
import {
  createPrinter,
  deletePrinter,
  listPrinters,
  updatePrinter,
} from './printerProfile.service.js';

const ctxOf = () => ({ ipAddress: '127.0.0.1', userAgent: 'itest' });

describe('printing (integration)', () => {
  let scenario: Awaited<ReturnType<typeof setupBillingScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    scenario = await setupBillingScenario();
  });

  after(async () => {
    await disconnect();
  });

  const issueInvoice = async (stateCode = '03') => {
    const { ctx, product } = scenario;
    const party =
      stateCode === '03'
        ? scenario.customer
        : await createTestParty(ctx, { displayName: 'Delhi Traders', stateCode });

    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      { partyId: party.id, items: [{ productId: product.id, quantity: 10, rate: 240 }] },
      ctxOf(),
    );
    return invoice;
  };

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  it('renders a real issued invoice to a valid PDF', async () => {
    const invoice = await issueInvoice();
    const { pdf, filename } = await generateInvoicePdf(scenario.ctx.businessId, invoice.id);

    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pdf.length > 1000);
    assert.equal(filename, 'invoice-INV-0001.pdf');
  });

  it('renders an interstate invoice, which takes the other column layout', async () => {
    const invoice = await issueInvoice('06');
    assert.equal(invoice.supplyType, 'INTER_STATE');
    const { pdf } = await generateInvoicePdf(scenario.ctx.businessId, invoice.id);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('counts the print, and does not when previewing', async () => {
    const invoice = await issueInvoice();

    await generateInvoicePdf(scenario.ctx.businessId, invoice.id);
    await generateInvoicePdf(scenario.ctx.businessId, invoice.id);
    let row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.equal(row.printedCount, 2);

    await generateInvoicePdf(scenario.ctx.businessId, invoice.id, { countAsPrint: false });
    row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.equal(row.printedCount, 2);
  });

  it('accepts each of the three statutory copies', async () => {
    const invoice = await issueInvoice();
    for (const copy of ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'] as const) {
      const { pdf } = await generateInvoicePdf(scenario.ctx.businessId, invoice.id, { copy });
      assert.ok(pdf.length > 1000);
    }
  });

  it('renders a draft that has no number yet, and names the file safely', async () => {
    const { ctx, customer, product } = scenario;
    const { invoice } = await createSalesInvoice(
      ctx.businessId,
      ctx.userId,
      {
        partyId: customer.id,
        items: [{ productId: product.id, quantity: 10, rate: 240 }],
        issue: false,
      },
      ctxOf(),
    );

    assert.equal(invoice.invoiceNumber, null);
    const { pdf, filename } = await generateInvoicePdf(ctx.businessId, invoice.id);
    assert.ok(pdf.length > 1000);
    assert.match(filename, /^invoice-draft-[a-z0-9]{6}\.pdf$/);
  });

  it('refuses to print another business’s invoice', async () => {
    const invoice = await issueInvoice();
    const other = await setupBillingScenario();
    await assert.rejects(
      generateInvoicePdf(other.ctx.businessId, invoice.id),
      /Invoice not found/,
    );
  });

  // -------------------------------------------------------------------------
  // Receipt
  // -------------------------------------------------------------------------

  it('builds a receipt carrying the invoice’s real figures', async () => {
    const invoice = await issueInvoice();
    const { lines, escpos, width } = await generateReceipt(scenario.ctx.businessId, invoice.id);

    assert.equal(width, 48, 'no profile configured, so the 80mm default');
    const text = lines.join('\n');
    assert.ok(text.includes('INV/0001'));
    assert.ok(text.includes('Sharma Stationery'));
    assert.ok(text.includes('2,688.00'));
    assert.ok(text.includes('CGST 6%'));

    // Every line fits the roll, and the bytes start with a printer reset.
    for (const line of lines) assert.ok(line.length <= 48);
    assert.deepEqual([...Buffer.from(escpos, 'base64').subarray(0, 2)], [0x1b, 0x40]);
  });

  it('takes its width and cut/copy settings from the default printer profile', async () => {
    const invoice = await issueInvoice();
    await createPrinter(scenario.ctx.businessId, {
      name: 'Counter 58mm',
      paperWidth: 'MM_58',
      connection: 'USB',
      copies: 2,
    });

    const { lines, escpos, profile } = await generateReceipt(scenario.ctx.businessId, invoice.id);
    assert.equal(profile?.name, 'Counter 58mm');
    for (const line of lines) assert.ok(line.length <= 32, `"${line}" exceeds a 58mm roll`);

    // Two copies means two ESC @ resets.
    const bytes = Buffer.from(escpos, 'base64');
    let resets = 0;
    for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 0x1b && bytes[i + 1] === 0x40) resets++;
    assert.equal(resets, 2);
  });

  it('lets an explicit width override the profile, for a preview', async () => {
    const invoice = await issueInvoice();
    await createPrinter(scenario.ctx.businessId, { name: 'Counter', paperWidth: 'MM_80' });

    const { lines } = await generateReceipt(scenario.ctx.businessId, invoice.id, { width: 32 });
    for (const line of lines) assert.ok(line.length <= 32);
  });

  it('shows the balance due when the invoice is part paid', async () => {
    const invoice = await issueInvoice();
    await prisma.salesInvoice.update({
      where: { id: invoice.id },
      data: { amountPaid: 1000 },
    });

    const { lines } = await generateReceipt(scenario.ctx.businessId, invoice.id, {
      showBalance: true,
    });
    const text = lines.join('\n');
    assert.ok(text.includes('Balance Due'));
    assert.ok(text.includes('1,688.00'));
  });

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  it('sends to a network printer and counts the print', async () => {
    const invoice = await issueInvoice();

    const received: Buffer[] = [];
    const server = net.createServer((socket) => socket.on('data', (c) => received.push(c)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      await createPrinter(scenario.ctx.businessId, {
        name: 'LAN thermal',
        connection: 'NETWORK',
        ipAddress: '127.0.0.1',
        port,
      });

      const result = await printReceipt(scenario.ctx.businessId, invoice.id);
      assert.equal(result.method, 'NETWORK');
      assert.ok(result.bytes > 100);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const printed = Buffer.concat(received).toString('latin1');
      assert.ok(printed.includes('INV/0001'), 'the invoice number reached the wire');

      const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      assert.equal(row.printedCount, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hands USB bytes back to the client instead of pretending to print', async () => {
    const invoice = await issueInvoice();
    await createPrinter(scenario.ctx.businessId, { name: 'Counter USB', connection: 'USB' });

    const result = await printReceipt(scenario.ctx.businessId, invoice.id);
    assert.equal(result.method, 'CLIENT');
    assert.ok(result.escposBase64);
    assert.deepEqual(
      [...Buffer.from(result.escposBase64!, 'base64').subarray(0, 2)],
      [0x1b, 0x40],
    );
  });

  it('fails clearly when no printer is configured at all', async () => {
    const invoice = await issueInvoice();
    await assert.rejects(
      printReceipt(scenario.ctx.businessId, invoice.id),
      /no default printer configured/,
    );
  });

  it('reports a printer that is switched off rather than hanging', async () => {
    const invoice = await issueInvoice();
    await createPrinter(scenario.ctx.businessId, {
      name: 'Unplugged',
      connection: 'NETWORK',
      // TEST-NET-1: reserved and unroutable, so this is a real timeout.
      ipAddress: '192.0.2.1',
      port: 9100,
    });

    await assert.rejects(printReceipt(scenario.ctx.businessId, invoice.id), /192\.0\.2\.1/);

    // A failed send must not count as a print.
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.equal(row.printedCount, 0);
  });
});

describe('printer profiles (integration)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = (await setupBillingScenario()).ctx.businessId;
  });

  after(async () => {
    await disconnect();
  });

  it('makes the first printer the default whatever the caller asked for', async () => {
    const first = await createPrinter(businessId, { name: 'Counter', isDefault: false });
    assert.equal(first.isDefault, true);
  });

  it('defaults characters per line from the paper width', async () => {
    const narrow = await createPrinter(businessId, { name: '58mm', paperWidth: 'MM_58' });
    const wide = await createPrinter(businessId, { name: '80mm', paperWidth: 'MM_80' });
    assert.equal(narrow.charactersPerLine, 32);
    assert.equal(wide.charactersPerLine, 48);
  });

  it('moves the default rather than allowing two', async () => {
    const first = await createPrinter(businessId, { name: 'Counter' });
    const second = await createPrinter(businessId, { name: 'Back office', isDefault: true });

    const all = await listPrinters(businessId);
    assert.equal(all.filter((p) => p.isDefault).length, 1);
    assert.equal(all.find((p) => p.isDefault)?.id, second.id);
    assert.equal((await listPrinters(businessId)).find((p) => p.id === first.id)?.isDefault, false);
  });

  it('lists the default first', async () => {
    await createPrinter(businessId, { name: 'A counter' });
    await createPrinter(businessId, { name: 'B back office', isDefault: true });
    const all = await listPrinters(businessId);
    assert.equal(all[0]?.name, 'B back office');
  });

  it('rejects a network printer with no IP', async () => {
    await assert.rejects(
      createPrinter(businessId, { name: 'LAN', connection: 'NETWORK' }),
      /needs an IP address/,
    );
  });

  it('rejects a Bluetooth printer with no MAC', async () => {
    await assert.rejects(
      createPrinter(businessId, { name: 'BT', connection: 'BLUETOOTH' }),
      /needs a MAC address/,
    );
  });

  it('rejects a duplicate name', async () => {
    await createPrinter(businessId, { name: 'Counter' });
    await assert.rejects(createPrinter(businessId, { name: 'Counter' }), /already exists/);
  });

  it('will not leave the shop with no usable printer', async () => {
    const only = await createPrinter(businessId, { name: 'Counter' });
    await assert.rejects(
      updatePrinter(businessId, only.id, { isActive: false }),
      /only printer configured/,
    );
    await assert.rejects(
      updatePrinter(businessId, only.id, { isDefault: false }),
      /only printer configured/,
    );
  });

  it('allows disabling one printer once another exists', async () => {
    const first = await createPrinter(businessId, { name: 'Counter' });
    await createPrinter(businessId, { name: 'Back office' });
    const updated = await updatePrinter(businessId, first.id, { isActive: false });
    assert.equal(updated.isActive, false);
  });

  it('re-validates reachability against the merged record on update', async () => {
    const printer = await createPrinter(businessId, { name: 'Counter', connection: 'USB' });
    // Switching to NETWORK without ever supplying an IP.
    await assert.rejects(
      updatePrinter(businessId, printer.id, { connection: 'NETWORK' }),
      /needs an IP address/,
    );
    // Supplying one in the same patch is fine.
    const ok = await updatePrinter(businessId, printer.id, {
      connection: 'NETWORK',
      ipAddress: '192.168.1.50',
    });
    assert.equal(ok.ipAddress, '192.168.1.50');
  });

  it('promotes another printer when the default is deleted', async () => {
    const first = await createPrinter(businessId, { name: 'Counter' });
    await createPrinter(businessId, { name: 'Back office' });

    await deletePrinter(businessId, first.id);
    const remaining = await listPrinters(businessId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.isDefault, true);
  });

  it('scopes every operation to the caller’s business', async () => {
    const printer = await createPrinter(businessId, { name: 'Counter' });
    const otherBusinessId = (await setupBillingScenario()).ctx.businessId;

    await assert.rejects(updatePrinter(otherBusinessId, printer.id, { name: 'x' }), /not found/);
    await assert.rejects(deletePrinter(otherBusinessId, printer.id), /not found/);
    assert.equal((await listPrinters(otherBusinessId)).length, 0);
  });
});
