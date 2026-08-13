import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { D, round3, round4 } from '../../lib/money.js';
import type { RequestContext } from '../auth/auth.service.js';
import { kgToBaseUnitFactor, parseSheetSize, reamWeightKg } from './paperWeight.js';
import type {
  adjustStockSchema,
  createProductSchema,
  listProductsQuerySchema,
  openingStockSchema,
  setProductUnitSchema,
  updateProductSchema,
} from './masters.schemas.js';

type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
type ListProductsFilter = z.infer<typeof listProductsQuerySchema>;
type SetProductUnitInput = z.infer<typeof setProductUnitSchema>;
type OpeningStockInput = z.infer<typeof openingStockSchema>;
type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/// UQC that identifies a kilogram unit, for auto-wiring the kg conversion.
const KG_UQC = 'KGS';

export async function createProduct(
  businessId: string,
  userId: string,
  input: CreateProductInput,
  ctx: RequestContext,
) {
  const [hsn, baseUnit, nameClash] = await Promise.all([
    prisma.hsnCode.findFirst({ where: { id: input.hsnCodeId, businessId } }),
    prisma.unit.findFirst({ where: { id: input.baseUnitId, businessId } }),
    prisma.product.findFirst({ where: { businessId, name: input.name }, select: { id: true } }),
  ]);
  if (!hsn) throw notFound('HSN code not found');
  if (!baseUnit) throw notFound('Base unit not found');
  if (nameClash) throw conflict(`A product named "${input.name}" already exists`);

  if (input.sheetSize && !parseSheetSize(input.sheetSize)) {
    throw badRequest(
      `Could not read the sheet size "${input.sheetSize}". Use "A4", "23x36" (inches), ` +
        '"70x100cm" or "210x297mm".',
    );
  }

  // Derive the ream weight from the paper spec unless it was given explicitly.
  const derivedWeight = reamWeightKg({
    gsm: input.gsm,
    sheetSize: input.sheetSize,
    sheetsPerReam: input.sheetsPerReam,
  });
  const weightPerBaseUnitKg = input.weightPerBaseUnitKg
    ? D(input.weightPerBaseUnitKg)
    : derivedWeight;

  const openingStock = D(input.openingStock ?? 0);
  const openingRate = D(input.openingStockRate ?? 0);

  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        businessId,
        name: input.name,
        aliasNames: input.aliasNames ?? [],
        sku: input.sku ?? null,
        brand: input.brand ?? null,
        description: input.description ?? null,
        hsnCodeId: input.hsnCodeId,
        baseUnitId: input.baseUnitId,
        gsm: input.gsm ?? null,
        sheetSize: input.sheetSize ?? null,
        sheetsPerReam: input.sheetsPerReam ?? null,
        weightPerBaseUnitKg,
        defaultSaleRate: input.defaultSaleRate ?? null,
        defaultPurchaseRate: input.defaultPurchaseRate ?? null,
        defaultSaleUnitId: input.defaultSaleUnitId ?? input.baseUnitId,
        defaultPurchaseUnitId: input.defaultPurchaseUnitId ?? null,
        reorderLevel: input.reorderLevel ?? null,
      },
    });

    // The base unit always converts 1:1 to itself. Storing it explicitly means
    // billing never has to special-case it.
    await tx.productUnit.create({
      data: {
        productId: created.id,
        unitId: input.baseUnitId,
        conversionToBase: 1,
        isSalesDefault: true,
        isPurchaseDefault: input.defaultPurchaseUnitId === undefined,
      },
    });

    // Auto-wire kg. This is the feature: he buys in kg and sells in reams, and
    // the factor comes out of the gsm/size/sheets spec rather than a calculator.
    const autoDerive = input.autoDeriveKgConversion !== false;
    if (autoDerive && weightPerBaseUnitKg && baseUnit.uqc !== KG_UQC) {
      const kgUnit = await tx.unit.findFirst({
        where: { businessId, uqc: KG_UQC, isActive: true },
      });
      const factor = kgToBaseUnitFactor(weightPerBaseUnitKg);
      if (kgUnit && factor) {
        await tx.productUnit.create({
          data: {
            productId: created.id,
            unitId: kgUnit.id,
            conversionToBase: factor,
            // Mills bill in kg, so that is the sensible purchase default.
            isPurchaseDefault: input.defaultPurchaseUnitId === undefined,
          },
        });
        if (input.defaultPurchaseUnitId === undefined) {
          await tx.product.update({
            where: { id: created.id },
            data: { defaultPurchaseUnitId: kgUnit.id },
          });
          await tx.productUnit.updateMany({
            where: { productId: created.id, unitId: input.baseUnitId },
            data: { isPurchaseDefault: false },
          });
        }
      }
    }

    await tx.productStock.create({
      data: {
        productId: created.id,
        businessId,
        quantityOnHand: openingStock,
        avgCostPerBaseUnit: openingRate,
        lastMovementAt: openingStock.isZero() ? null : new Date(),
      },
    });

    if (!openingStock.isZero()) {
      await tx.stockMovement.create({
        data: {
          businessId,
          productId: created.id,
          movementType: 'OPENING',
          movementDate: new Date(),
          baseQuantity: openingStock,
          ratePerBaseUnit: openingRate,
          balanceAfter: openingStock,
          referenceType: 'OPENING_STOCK',
          notes: 'Opening stock on migration',
          createdById: userId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'product.create',
        entityType: 'Product',
        entityId: created.id,
        after: { name: created.name, hsn: hsn.code, weightPerBaseUnitKg: weightPerBaseUnitKg?.toString() ?? null },
        ipAddress: ctx.ipAddress ?? null,
      },
    });

    return created;
  });

  return getProduct(businessId, product.id);
}

export async function updateProduct(
  businessId: string,
  userId: string,
  productId: string,
  patch: UpdateProductInput,
  ctx: RequestContext,
) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw notFound('Product not found');

  if (patch.name && patch.name !== product.name) {
    const clash = await prisma.product.findFirst({
      where: { businessId, name: patch.name, id: { not: productId } },
      select: { id: true },
    });
    if (clash) throw conflict(`A product named "${patch.name}" already exists`);
  }

  if (patch.hsnCodeId) {
    const hsn = await prisma.hsnCode.findFirst({ where: { id: patch.hsnCodeId, businessId } });
    if (!hsn) throw notFound('HSN code not found');
  }

  if (patch.sheetSize && !parseSheetSize(patch.sheetSize)) {
    throw badRequest(`Could not read the sheet size "${patch.sheetSize}"`);
  }

  // Recompute the weight when any input to it changed and no explicit override
  // was supplied. Note this deliberately does NOT rewrite existing
  // ProductUnit rows — past invoices snapshotted their factor, and changing a
  // live conversion silently would make future stock disagree with history.
  const specChanged =
    patch.gsm !== undefined || patch.sheetSize !== undefined || patch.sheetsPerReam !== undefined;
  let weightPerBaseUnitKg: Prisma.Decimal | null | undefined;
  if (patch.weightPerBaseUnitKg !== undefined) {
    weightPerBaseUnitKg = D(patch.weightPerBaseUnitKg);
  } else if (specChanged) {
    weightPerBaseUnitKg = reamWeightKg({
      gsm: patch.gsm ?? product.gsm ?? undefined,
      sheetSize: patch.sheetSize ?? product.sheetSize ?? undefined,
      sheetsPerReam: patch.sheetsPerReam ?? product.sheetsPerReam ?? undefined,
    });
  }

  const { autoDeriveKgConversion: _auto, ...rest } = patch;

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      ...rest,
      ...(weightPerBaseUnitKg !== undefined ? { weightPerBaseUnitKg } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId,
      action: 'product.update',
      entityType: 'Product',
      entityId: productId,
      before: { name: product.name, defaultSaleRate: product.defaultSaleRate?.toString() ?? null, isActive: product.isActive },
      after: { name: updated.name, defaultSaleRate: updated.defaultSaleRate?.toString() ?? null, isActive: updated.isActive },
      ipAddress: ctx.ipAddress ?? null,
    },
  });

  return getProduct(businessId, productId);
}

export async function getProduct(businessId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, businessId },
    include: {
      hsnCode: { include: { taxRates: { orderBy: { effectiveFrom: 'desc' }, take: 5 } } },
      baseUnit: true,
      productUnits: { include: { unit: true }, orderBy: { conversionToBase: 'desc' } },
      stock: true,
    },
  });
  if (!product) throw notFound('Product not found');

  const now = new Date();
  const currentRate =
    product.hsnCode.taxRates.find(
      (r) => r.effectiveFrom <= now && (r.effectiveTo === null || r.effectiveTo >= now),
    ) ?? null;

  return {
    ...product,
    currentTaxRate: currentRate,
    /// Surfaced so the UI can warn before the product is ever put on a bill.
    billable: currentRate !== null,
    quantityOnHand: D(product.stock?.quantityOnHand ?? 0),
    stockValue: D(product.stock?.quantityOnHand ?? 0).times(D(product.stock?.avgCostPerBaseUnit ?? 0)),
    lowStock:
      product.reorderLevel !== null &&
      D(product.stock?.quantityOnHand ?? 0).lessThanOrEqualTo(D(product.reorderLevel)),
  };
}

export async function listProducts(businessId: string, filter: ListProductsFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.ProductWhereInput = {
    businessId,
    ...(filter.hsnCodeId ? { hsnCodeId: filter.hsnCodeId } : {}),
    ...(filter.isActive !== undefined ? { isActive: filter.isActive } : {}),
    ...(filter.search
      ? {
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' } },
            { brand: { contains: filter.search, mode: 'insensitive' } },
            { sku: { contains: filter.search, mode: 'insensitive' } },
            // Voice and typeahead both benefit from searching spoken aliases.
            { aliasNames: { has: filter.search } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        hsnCode: { select: { code: true } },
        baseUnit: { select: { name: true, symbol: true } },
        stock: { select: { quantityOnHand: true, avgCostPerBaseUnit: true } },
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  const mapped = rows.map((p) => {
    const onHand = D(p.stock?.quantityOnHand ?? 0);
    return {
      ...p,
      quantityOnHand: onHand,
      stockValue: onHand.times(D(p.stock?.avgCostPerBaseUnit ?? 0)),
      lowStock: p.reorderLevel !== null && onHand.lessThanOrEqualTo(D(p.reorderLevel)),
    };
  });

  // Low stock compares two columns, which Prisma can't express in `where` here,
  // so it filters the page. Acceptable: this is a review list, not a hot path.
  return {
    products: filter.lowStockOnly ? mapped.filter((p) => p.lowStock) : mapped,
    total,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Product units — the reams↔kg bridge
// ---------------------------------------------------------------------------

export async function setProductUnit(
  businessId: string,
  productId: string,
  input: SetProductUnitInput,
) {
  const [product, unit] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, businessId } }),
    prisma.unit.findFirst({ where: { id: input.unitId, businessId } }),
  ]);
  if (!product) throw notFound('Product not found');
  if (!unit) throw notFound('Unit not found');

  if (input.unitId === product.baseUnitId && D(input.conversionToBase).comparedTo(1) !== 0) {
    throw badRequest('The base unit must convert to itself at exactly 1');
  }

  return prisma.$transaction(async (tx) => {
    // Only one default of each kind per product.
    if (input.isSalesDefault) {
      await tx.productUnit.updateMany({ where: { productId }, data: { isSalesDefault: false } });
      await tx.product.update({ where: { id: productId }, data: { defaultSaleUnitId: input.unitId } });
    }
    if (input.isPurchaseDefault) {
      await tx.productUnit.updateMany({ where: { productId }, data: { isPurchaseDefault: false } });
      await tx.product.update({ where: { id: productId }, data: { defaultPurchaseUnitId: input.unitId } });
    }

    return tx.productUnit.upsert({
      where: { productId_unitId: { productId, unitId: input.unitId } },
      create: {
        productId,
        unitId: input.unitId,
        conversionToBase: input.conversionToBase,
        isSalesDefault: input.isSalesDefault ?? false,
        isPurchaseDefault: input.isPurchaseDefault ?? false,
      },
      update: {
        conversionToBase: input.conversionToBase,
        ...(input.isSalesDefault !== undefined ? { isSalesDefault: input.isSalesDefault } : {}),
        ...(input.isPurchaseDefault !== undefined ? { isPurchaseDefault: input.isPurchaseDefault } : {}),
      },
      include: { unit: true },
    });
  });
}

export async function deleteProductUnit(businessId: string, productId: string, unitId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw notFound('Product not found');
  if (unitId === product.baseUnitId) throw badRequest('The base unit cannot be removed');

  await prisma.productUnit.deleteMany({ where: { productId, unitId } });

  // Past invoices snapshotted their own conversion factor, so removing the row
  // affects future billing only — history stays intact.
  if (product.defaultSaleUnitId === unitId || product.defaultPurchaseUnitId === unitId) {
    await prisma.product.update({
      where: { id: productId },
      data: {
        ...(product.defaultSaleUnitId === unitId ? { defaultSaleUnitId: product.baseUnitId } : {}),
        ...(product.defaultPurchaseUnitId === unitId ? { defaultPurchaseUnitId: null } : {}),
      },
    });
  }

  return { deleted: true };
}

/**
 * What the kg conversion *would* be, given the current paper spec. Lets the UI
 * show "1 kg = 0.4276 reams (a ream weighs 2.3389 kg)" before saving.
 */
export async function suggestKgConversion(businessId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, businessId },
    include: { baseUnit: true },
  });
  if (!product) throw notFound('Product not found');

  const weight =
    product.weightPerBaseUnitKg ??
    reamWeightKg({
      gsm: product.gsm ?? undefined,
      sheetSize: product.sheetSize ?? undefined,
      sheetsPerReam: product.sheetsPerReam ?? undefined,
    });

  if (!weight) {
    return {
      available: false,
      reason:
        'Set the GSM, sheet size and sheets per ream (or enter the weight directly) to derive the kg conversion.',
    };
  }

  const factor = kgToBaseUnitFactor(weight);
  return {
    available: true,
    weightPerBaseUnitKg: round4(weight),
    conversionToBase: factor,
    explanation:
      `One ${product.baseUnit.name.toLowerCase()} weighs ${round4(weight).toString()} kg, ` +
      `so 1 kg = ${factor?.toString()} ${product.baseUnit.name.toLowerCase()}.`,
  };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * Sets opening stock. Only valid once, before any other movement — after that
 * the correct instrument is an adjustment, which leaves a reason on the record.
 */
export async function setOpeningStock(
  businessId: string,
  userId: string,
  productId: string,
  input: OpeningStockInput,
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, businessId },
    include: { stock: true },
  });
  if (!product) throw notFound('Product not found');

  const existingMovements = await prisma.stockMovement.count({ where: { productId } });
  if (existingMovements > 0) {
    throw badRequest(
      'This product already has stock movements. Use a stock adjustment instead so the change is explained.',
    );
  }

  const quantity = round3(D(input.quantity));
  const rate = round4(D(input.ratePerBaseUnit));
  const asOfDate = input.asOfDate ?? new Date();

  await prisma.$transaction([
    prisma.productStock.upsert({
      where: { productId },
      create: {
        productId,
        businessId,
        quantityOnHand: quantity,
        avgCostPerBaseUnit: rate,
        lastMovementAt: asOfDate,
      },
      update: { quantityOnHand: quantity, avgCostPerBaseUnit: rate, lastMovementAt: asOfDate },
    }),
    prisma.stockMovement.create({
      data: {
        businessId,
        productId,
        movementType: 'OPENING',
        movementDate: asOfDate,
        baseQuantity: quantity,
        ratePerBaseUnit: rate,
        balanceAfter: quantity,
        referenceType: 'OPENING_STOCK',
        notes: 'Opening stock',
        createdById: userId,
      },
    }),
  ]);

  return getProduct(businessId, productId);
}

/**
 * Manual stock correction — damage, shrinkage, a recount.
 *
 * Deliberately requires a reason. An unexplained stock change is the thing that
 * makes a stock report untrustworthy six months later.
 */
export async function adjustStock(
  businessId: string,
  userId: string,
  productId: string,
  input: AdjustStockInput,
  ctx: RequestContext,
) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw notFound('Product not found');

  const delta = round3(D(input.quantity));
  const asOfDate = input.asOfDate ?? new Date();

  const stock = await prisma.$transaction(async (tx) => {
    const updated = await tx.productStock.upsert({
      where: { productId },
      create: {
        productId,
        businessId,
        quantityOnHand: delta,
        avgCostPerBaseUnit: 0,
        lastMovementAt: asOfDate,
      },
      update: { quantityOnHand: { increment: delta }, lastMovementAt: asOfDate },
    });

    await tx.stockMovement.create({
      data: {
        businessId,
        productId,
        movementType: delta.greaterThan(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        movementDate: asOfDate,
        baseQuantity: delta,
        ratePerBaseUnit: updated.avgCostPerBaseUnit,
        balanceAfter: updated.quantityOnHand,
        referenceType: 'ADJUSTMENT',
        notes: input.reason,
        createdById: userId,
      },
    });

    await tx.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'stock.adjust',
        entityType: 'Product',
        entityId: productId,
        after: { delta: delta.toString(), balanceAfter: updated.quantityOnHand.toString(), reason: input.reason },
        ipAddress: ctx.ipAddress ?? null,
      },
    });

    return updated;
  });

  return { productId, quantityOnHand: stock.quantityOnHand, adjustedBy: delta };
}

/** Movement history for one product — the answer to "where did my stock go?". */
export async function getStockHistory(
  businessId: string,
  productId: string,
  options: { fromDate?: Date; toDate?: Date; page?: number; pageSize?: number } = {},
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, businessId },
    include: { baseUnit: { select: { name: true, symbol: true } }, stock: true },
  });
  if (!product) throw notFound('Product not found');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, options.pageSize ?? 100));

  const where: Prisma.StockMovementWhereInput = {
    businessId,
    productId,
    ...(options.fromDate || options.toDate
      ? {
          movementDate: {
            ...(options.fromDate ? { gte: options.fromDate } : {}),
            ...(options.toDate ? { lte: options.toDate } : {}),
          },
        }
      : {}),
  };

  const [movements, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return {
    product: {
      id: product.id,
      name: product.name,
      baseUnit: product.baseUnit,
      quantityOnHand: D(product.stock?.quantityOnHand ?? 0),
      avgCostPerBaseUnit: D(product.stock?.avgCostPerBaseUnit ?? 0),
    },
    movements,
    total,
    page,
    pageSize,
  };
}
