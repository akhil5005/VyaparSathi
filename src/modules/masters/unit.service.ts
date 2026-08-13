import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { createUnitSchema, updateUnitSchema } from './masters.schemas.js';

type CreateUnitInput = z.infer<typeof createUnitSchema>;
type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

export async function listUnits(businessId: string, includeInactive = false) {
  return prisma.unit.findMany({
    where: { businessId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
}

export async function createUnit(businessId: string, input: CreateUnitInput) {
  const existing = await prisma.unit.findFirst({
    where: { businessId, symbol: input.symbol },
    select: { id: true },
  });
  if (existing) throw conflict(`A unit with the symbol "${input.symbol}" already exists`);

  return prisma.unit.create({
    data: {
      businessId,
      name: input.name,
      symbol: input.symbol,
      uqc: input.uqc,
      allowDecimal: input.allowDecimal ?? true,
    },
  });
}

export async function updateUnit(businessId: string, unitId: string, patch: UpdateUnitInput) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, businessId } });
  if (!unit) throw notFound('Unit not found');

  if (patch.symbol && patch.symbol !== unit.symbol) {
    const clash = await prisma.unit.findFirst({
      where: { businessId, symbol: patch.symbol, id: { not: unitId } },
      select: { id: true },
    });
    if (clash) throw conflict(`A unit with the symbol "${patch.symbol}" already exists`);
  }

  // Deactivating a unit that products still convert through would break their
  // billing, so block it rather than let the error surface at invoice time.
  if (patch.isActive === false) {
    const inUse = await prisma.productUnit.count({ where: { unitId } });
    const isBaseUnit = await prisma.product.count({ where: { baseUnitId: unitId } });
    if (inUse > 0 || isBaseUnit > 0) {
      throw badRequest(
        `"${unit.name}" is used by ${inUse + isBaseUnit} product(s). Remove it from them first.`,
      );
    }
  }

  return prisma.unit.update({ where: { id: unitId }, data: patch });
}
