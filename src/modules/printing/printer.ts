import net from 'node:net';
import type { PrinterProfile } from '@prisma/client';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Getting bytes to a thermal printer.
 *
 * Only one connection type can be driven from the server: NETWORK. A printer on
 * the shop LAN listens on TCP 9100 (the JetDirect/raw port) and prints whatever
 * bytes you write to the socket — no driver, no spooler, no queue.
 *
 * USB, Bluetooth and SYSTEM printers are attached to the *operator's* machine,
 * not the server's. The server has no route to them, and pretending otherwise
 * by shelling out to `lp`/`RawPrint` would only work when the API happens to
 * run on the same PC as the counter. So for those the API returns the ESC/POS
 * buffer and the client sends it — over WebUSB, the Web Bluetooth API, or a
 * small local agent. That keeps the byte generation (the hard part, and the
 * part worth testing) on the server, and the last hop where the device is.
 */

export type DispatchMethod = 'NETWORK' | 'CLIENT';

export interface DispatchResult {
  method: DispatchMethod;
  /// Present for CLIENT dispatch: the raw ESC/POS the caller must forward.
  payload?: Buffer;
  bytes: number;
  /// Human-readable, safe to show in the UI toast.
  detail: string;
}

export interface NetworkTarget {
  host: string;
  port: number;
  timeoutMs?: number;
}

/**
 * Writes a buffer to a raw TCP printer socket.
 *
 * Resolves once the bytes are flushed and the socket closes cleanly. A thermal
 * printer never replies, so there is nothing to read back and no way to know
 * the paper didn't jam — a successful write means "the printer accepted the
 * job", not "the customer has a receipt in hand".
 */
export function sendToNetworkPrinter(data: Buffer, target: NetworkTarget): Promise<void> {
  const timeoutMs = target.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () =>
      finish(new Error(`Printer at ${target.host}:${target.port} did not respond in ${timeoutMs}ms`)),
    );
    socket.once('error', (error) =>
      finish(new Error(`Printer at ${target.host}:${target.port}: ${error.message}`)),
    );

    socket.connect(target.port, target.host, () => {
      socket.end(data, () => finish());
    });
  });
}

/**
 * Sends the job by whatever route the profile allows.
 *
 * Never throws for a non-network profile — those are a normal, expected outcome
 * where the browser finishes the job.
 */
export async function dispatch(data: Buffer, profile: PrinterProfile): Promise<DispatchResult> {
  if (profile.connection !== 'NETWORK') {
    return {
      method: 'CLIENT',
      payload: data,
      bytes: data.length,
      detail: `${profile.connection} printer — the client sends these bytes to the device`,
    };
  }

  if (!profile.ipAddress) {
    throw badRequest(`Printer "${profile.name}" is set to NETWORK but has no IP address`);
  }

  const port = profile.port ?? 9100;
  await sendToNetworkPrinter(data, { host: profile.ipAddress, port });
  logger.info({ printer: profile.name, bytes: data.length }, 'print job sent');

  return {
    method: 'NETWORK',
    bytes: data.length,
    detail: `Sent to ${profile.ipAddress}:${port}`,
  };
}

/**
 * Opens and closes a socket without printing.
 *
 * The one honest health check available: if TCP 9100 accepts a connection the
 * printer is powered on and on the network. It says nothing about paper.
 */
export async function testConnection(profile: PrinterProfile): Promise<{ reachable: boolean; detail: string }> {
  if (profile.connection !== 'NETWORK') {
    return { reachable: false, detail: 'Only network printers can be tested from the server' };
  }
  if (!profile.ipAddress) {
    return { reachable: false, detail: 'No IP address configured' };
  }

  const port = profile.port ?? 9100;
  try {
    await sendToNetworkPrinter(Buffer.alloc(0), { host: profile.ipAddress, port, timeoutMs: 3000 });
    return { reachable: true, detail: `${profile.ipAddress}:${port} accepted a connection` };
  } catch (error) {
    return { reachable: false, detail: (error as Error).message };
  }
}
