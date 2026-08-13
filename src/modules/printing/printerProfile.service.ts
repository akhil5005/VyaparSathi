import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { CHARS_PER_LINE } from './escpos.js';
import { testConnection } from './printer.js';
import type { createPrinterSchema, updatePrinterSchema } from './print.schemas.js';

type CreatePrinterInput = z.infer<typeof createPrinterSchema>;
type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>;

/**
 * Rejects a profile that can't actually be printed to.
 *
 * A network printer with no IP and a Bluetooth printer with no MAC are both
 * saveable in the schema but useless at the counter, and the failure would only
 * show up when someone is standing there waiting for a bill.
 */
function assertReachable(input: {
  connection?: string;
  ipAddress?: string | null;
  macAddress?: string | null;
  deviceName?: string | null;
}) {
  if (input.connection === 'NETWORK' && !input.ipAddress) {
    throw badRequest('A network printer needs an IP address');
  }
  if (input.connection === 'BLUETOOTH' && !input.macAddress) {
    throw badRequest('A Bluetooth printer needs a MAC address');
  }
}

/**
 * There can be only one default, so setting a new one clears the old.
 *
 * Done inside the caller's transaction: two operators ticking "default" at the
 * same moment would otherwise both succeed and leave the shop with two.
 */
async function clearOtherDefaults(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  businessId: string,
  keepId?: string,
) {
  await tx.printerProfile.updateMany({
    where: { businessId, isDefault: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export async function listPrinters(businessId: string, includeInactive = false) {
  return prisma.printerProfile.findMany({
    where: { businessId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
}

export async function getPrinter(businessId: string, printerId: string) {
  const printer = await prisma.printerProfile.findFirst({ where: { id: printerId, businessId } });
  if (!printer) throw notFound('Printer profile not found');
  return printer;
}

export async function createPrinter(businessId: string, input: CreatePrinterInput) {
  assertReachable(input);

  const clash = await prisma.printerProfile.findFirst({
    where: { businessId, name: input.name },
    select: { id: true },
  });
  if (clash) throw conflict(`A printer called "${input.name}" already exists`);

  const existingCount = await prisma.printerProfile.count({ where: { businessId } });
  // The first printer configured is the default, whatever the caller said —
  // otherwise the shop has one printer and no default, and every print fails.
  // Note this cannot be `input.isDefault ?? existingCount === 0`: an explicit
  // `false` is not nullish, so that form would honour it and leave no default.
  const isDefault = existingCount === 0 ? true : (input.isDefault ?? false);

  const paperWidth = input.paperWidth ?? 'MM_80';
  const charactersPerLine = input.charactersPerLine ?? CHARS_PER_LINE[paperWidth] ?? 48;

  return prisma.$transaction(async (tx) => {
    if (isDefault) await clearOtherDefaults(tx, businessId);
    return tx.printerProfile.create({
      data: { businessId, ...input, paperWidth, charactersPerLine, isDefault },
    });
  });
}

export async function updatePrinter(
  businessId: string,
  printerId: string,
  patch: UpdatePrinterInput,
) {
  const printer = await getPrinter(businessId, printerId);

  assertReachable({
    connection: patch.connection ?? printer.connection,
    ipAddress: patch.ipAddress ?? printer.ipAddress,
    macAddress: patch.macAddress ?? printer.macAddress,
    deviceName: patch.deviceName ?? printer.deviceName,
  });

  if (patch.name && patch.name !== printer.name) {
    const clash = await prisma.printerProfile.findFirst({
      where: { businessId, name: patch.name, id: { not: printerId } },
      select: { id: true },
    });
    if (clash) throw conflict(`A printer called "${patch.name}" already exists`);
  }

  // Un-defaulting the only default leaves nothing for `printReceipt` to find.
  if ((patch.isDefault === false || patch.isActive === false) && printer.isDefault) {
    const alternatives = await prisma.printerProfile.count({
      where: { businessId, isActive: true, id: { not: printerId } },
    });
    if (alternatives === 0) {
      throw badRequest('This is the only printer configured — set up another before disabling it');
    }
  }

  return prisma.$transaction(async (tx) => {
    if (patch.isDefault) await clearOtherDefaults(tx, businessId, printerId);
    return tx.printerProfile.update({ where: { id: printerId }, data: patch });
  });
}

export async function deletePrinter(businessId: string, printerId: string) {
  const printer = await getPrinter(businessId, printerId);
  await prisma.printerProfile.delete({ where: { id: printer.id } });

  // Promote something so the shop is never left without a default.
  if (printer.isDefault) {
    const next = await prisma.printerProfile.findFirst({
      where: { businessId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (next) {
      await prisma.printerProfile.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  }

  return { deleted: true };
}

export async function testPrinter(businessId: string, printerId: string) {
  return testConnection(await getPrinter(businessId, printerId));
}
