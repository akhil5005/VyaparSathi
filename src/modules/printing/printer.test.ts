import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { PrinterProfile } from '@prisma/client';
import { dispatch, sendToNetworkPrinter, testConnection } from './printer.js';

/**
 * A raw TCP socket is exactly what a 9100-port thermal printer is, so a local
 * `net.Server` is not a mock — it is the same protocol with the print head
 * replaced by a Buffer. The one thing it can't reproduce is a printer that
 * accepts the connection and then jams, which is precisely the failure this
 * transport cannot detect anyway.
 */

const profile = (overrides: Partial<PrinterProfile> = {}): PrinterProfile =>
  ({
    id: 'p1',
    businessId: 'b1',
    name: 'Counter thermal',
    paperWidth: 'MM_80',
    connection: 'NETWORK',
    ipAddress: '127.0.0.1',
    port: 9100,
    deviceName: null,
    macAddress: null,
    codePage: 0,
    charactersPerLine: 48,
    cutAfterPrint: true,
    openCashDrawer: false,
    copies: 1,
    isDefault: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as PrinterProfile;

describe('sendToNetworkPrinter', () => {
  let server: net.Server;
  let port: number;
  let received: Buffer[] = [];

  before(async () => {
    server = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers the bytes verbatim', async () => {
    received = [];
    const payload = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a]);
    await sendToNetworkPrinter(payload, { host: '127.0.0.1', port });

    // The socket close races the server's last 'data' event on some platforms.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(Buffer.concat(received), payload);
  });

  it('reports a refused connection with the address in the message', async () => {
    await assert.rejects(
      // Port 1 is reserved and nothing listens on it.
      sendToNetworkPrinter(Buffer.from('x'), { host: '127.0.0.1', port: 1, timeoutMs: 1000 }),
      /127\.0\.0\.1:1/,
    );
  });

  it('gives up on an unreachable host instead of hanging the request', async () => {
    // 192.0.2.0/24 is TEST-NET-1: reserved, guaranteed unroutable.
    await assert.rejects(
      sendToNetworkPrinter(Buffer.from('x'), { host: '192.0.2.1', port: 9100, timeoutMs: 300 }),
      /192\.0\.2\.1:9100/,
    );
  });

  it('reports reachable via testConnection', async () => {
    const result = await testConnection(profile({ port }));
    assert.equal(result.reachable, true);
    assert.match(result.detail, /accepted a connection/);
  });

  it('reports unreachable rather than throwing', async () => {
    const result = await testConnection(profile({ ipAddress: '192.0.2.1' }));
    assert.equal(result.reachable, false);
  });

  it('dispatches over the network for a NETWORK profile', async () => {
    received = [];
    const result = await dispatch(Buffer.from('hello'), profile({ port }));
    assert.equal(result.method, 'NETWORK');
    assert.equal(result.bytes, 5);
    assert.equal(result.payload, undefined);
  });
});

describe('dispatch for non-network printers', () => {
  it('hands USB bytes back for the client to send', async () => {
    const result = await dispatch(Buffer.from('hello'), profile({ connection: 'USB' }));
    assert.equal(result.method, 'CLIENT');
    assert.equal(result.payload?.toString(), 'hello');
    assert.equal(result.bytes, 5);
  });

  it('does the same for Bluetooth and the OS spooler', async () => {
    for (const connection of ['BLUETOOTH', 'SYSTEM'] as const) {
      const result = await dispatch(Buffer.from('x'), profile({ connection }));
      assert.equal(result.method, 'CLIENT');
      assert.ok(result.detail.includes(connection));
    }
  });

  it('refuses a network profile with no IP rather than dialling undefined', async () => {
    await assert.rejects(
      dispatch(Buffer.from('x'), profile({ ipAddress: null })),
      /no IP address/,
    );
  });

  it('cannot test a USB printer from the server', async () => {
    const result = await testConnection(profile({ connection: 'USB' }));
    assert.equal(result.reachable, false);
    assert.match(result.detail, /Only network printers/);
  });
});
