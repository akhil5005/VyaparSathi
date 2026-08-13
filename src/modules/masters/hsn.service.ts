import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { D } from '../../lib/money.js';
import type { addHsnRateSchema, createHsnSchema, updateHsnSchema } from './masters.schemas.js';

type CreateHsnInput = z.infer<typeof createHsnSchema>;
type UpdateHsnInput = z.infer<typeof updateHsnSchema>;
type AddRateInput = z.infer<typeof addHsnRateSchema>;

export async function listHsnCodes(businessId: string) {
  const codes = await prisma.hsnCode.findMany({
    where: { businessId },
    include: { taxRates: { orderBy: { effectiveFrom: 'desc' } }, _count: { select: { products: true } } },
    orderBy: { code: 'asc' },
  });

  const now = new Date();
  return codes.map((hsn) => ({
    ...hsn,
    /// The rate that applies today — what the UI should show in the list.
    currentRate:
      hsn.taxRates.find(
        (r) => r.effectiveFrom <= now && (r.effectiveTo === null || r.effectiveTo >= now),
      ) ?? null,
    productCount: hsn._count.products,
  }));
}

export async function getHsnCode(businessId: string, hsnCodeId: string) {
  const hsn = await prisma.hsnCode.findFirst({
    where: { id: hsnCodeId, businessId },
    include: { taxRates: { orderBy: { effectiveFrom: 'desc' } } },
  });
  if (!hsn) throw notFound('HSN code not found');
  return hsn;
}

export async function createHsnCode(businessId: string, input: CreateHsnInput) {
  const existing = await prisma.hsnCode.findFirst({
    where: { businessId, code: input.code },
    select: { id: true },
  });
  if (existing) throw conflict(`HSN ${input.code} already exists`);

  return prisma.hsnCode.create({
    data: {
      businessId,
      code: input.code,
      description: input.description,
      // The rate is optional here, but a product on an HSN with no rate cannot
      // be billed — the invoice service refuses rather than guessing zero.
      ...(input.gstRate !== undefined
        ? {
            taxRates: {
              create: {
                gstRate: input.gstRate,
                cessRate: input.cessRate ?? 0,
                effectiveFrom: input.effectiveFrom ?? new Date(),
              },
            },
          }
        : {}),
    },
    include: { taxRates: true },
  });
}

export async function updateHsnCode(businessId: string, hsnCodeId: string, patch: UpdateHsnInput) {
  await getHsnCode(businessId, hsnCodeId);
  return prisma.hsnCode.update({ where: { id: hsnCodeId }, data: patch });
}

/**
 * Adds a rate revision and closes the previous one.
 *
 * Rates are never edited in place. When the Council revises a slab you add a
 * row with the new `effectiveFrom`; the open row is closed the instant before
 * it. That is what lets an invoice from two years ago reprint with the rate
 * that actually applied on its date.
 */
export async function addHsnRate(businessId: string, hsnCodeId: string, input: AddRateInput) {
  const hsn = await getHsnCode(businessId, hsnCodeId);

  const clash = hsn.taxRates.find(
    (r) => r.effectiveFrom.getTime() === input.effectiveFrom.getTime(),
  );
  if (clash) throw conflict('A rate already starts on that date. Edit or delete it instead.');

  const laterRate = hsn.taxRates.find((r) => r.effectiveFrom > input.effectiveFrom);
  if (laterRate) {
    throw badRequest(
      `A later rate already starts on ${laterRate.effectiveFrom.toISOString().slice(0, 10)}. ` +
        'Add rates in chronological order, or delete the later one first.',
    );
  }

  const openRate = hsn.taxRates.find((r) => r.effectiveTo === null);

  return prisma.$transaction(async (tx) => {
    if (openRate) {
      if (openRate.effectiveFrom >= input.effectiveFrom) {
        throw badRequest('The new rate must start after the current one');
      }
      await tx.hsnTaxRate.update({
        where: { id: openRate.id },
        // One millisecond before the new rate starts — no gap, no overlap.
        data: { effectiveTo: new Date(input.effectiveFrom.getTime() - 1) },
      });
    }

    return tx.hsnTaxRate.create({
      data: {
        hsnCodeId,
        gstRate: input.gstRate,
        cessRate: input.cessRate ?? 0,
        effectiveFrom: input.effectiveFrom,
        notes: input.notes ?? null,
      },
    });
  });
}

/**
 * Deletes a rate row and reopens the one before it. Only for correcting a
 * mistyped rate that was never billed against.
 */
export async function deleteHsnRate(businessId: string, hsnCodeId: string, rateId: string) {
  const hsn = await getHsnCode(businessId, hsnCodeId);
  const rate = hsn.taxRates.find((r) => r.id === rateId);
  if (!rate) throw notFound('Rate not found');

  // If an invoice was issued while this rate was in force, deleting it would
  // orphan the history that explains that invoice's tax.
  const invoicesInWindow = await prisma.salesInvoice.count({
    where: {
      businessId,
      status: { not: 'DRAFT' },
      invoiceDate: {
        gte: rate.effectiveFrom,
        ...(rate.effectiveTo ? { lte: rate.effectiveTo } : {}),
      },
      items: { some: { product: { hsnCodeId } } },
    },
  });
  if (invoicesInWindow > 0) {
    throw badRequest(
      `${invoicesInWindow} invoice(s) were issued under this rate. It cannot be deleted — ` +
        'add a corrected rate going forward instead.',
    );
  }

  const previous = hsn.taxRates
    .filter((r) => r.id !== rateId && r.effectiveFrom < rate.effectiveFrom)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];

  await prisma.$transaction(async (tx) => {
    await tx.hsnTaxRate.delete({ where: { id: rateId } });
    if (previous) {
      // Reopen the previous rate so there is no gap in coverage.
      await tx.hsnTaxRate.update({
        where: { id: previous.id },
        data: { effectiveTo: rate.effectiveTo },
      });
    }
  });

  return { deleted: true };
}

/** The rate in force on a date. Mirrors what the invoice service looks up. */
export async function rateAsOf(hsnCodeId: string, date: Date) {
  const rate = await prisma.hsnTaxRate.findFirst({
    where: {
      hsnCodeId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rate ? { gstRate: D(rate.gstRate), cessRate: D(rate.cessRate) } : null;
}
