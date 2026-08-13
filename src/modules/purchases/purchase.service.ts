import { Prisma, type SupplyType } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { D, round2, round3, sum, ZERO, type Numeric } from '../../lib/money.js';
import { financialYearOf } from '../../lib/financialYear.js';
import { resolveSupplyType } from '../../lib/gstin.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { allocateDocumentNumber } from '../invoices/numbering.js';
import { computeInvoiceTotals, computeLine, formatHsn, type ComputedLine } from '../invoices/tax.js';
import type { RequestContext } from '../auth/auth.service.js';
import {
  apportionCharges,
  landedCostPerBaseUnit,
  movingAverageCost,
  reconcileWithSupplierTotal,
} from './costing.js';
import type { listPurchasesQuerySchema } from './purchase.schemas.js';

type ListPurchasesFilter = z.infer<typeof listPurchasesQuerySchema>;

/**
 * Service-level input. Hand-written rather than inferred from the Zod schema so
 * money fields accept a number or a string — the HTTP layer normalises to
 * strings, but a direct caller shouldn't have to.
 */
export interface PurchaseItemInput {
  productId: string;
  quantity: Numeric;
  unitId?: string;
  rate: Numeric;
  discountPercent?: Numeric;
  discountAmount?: Numeric;
  /// Override when the supplier billed a rate other than the HSN master's.
  gstRate?: Numeric;
  cessRate?: Numeric;
}

export interface CreatePurchaseInput {
  partyId: string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: Date;
  items: PurchaseItemInput[];
  freightCharges?: Numeric;
  otherCharges?: Numeric;
  reverseCharge?: boolean;
  itcEligible?: boolean;
  supplierGrandTotal?: Numeric;
  notes?: string;
  issue?: boolean;
}

export interface PurchaseWarning {
  code: 'SUPPLIER_TOTAL_MISMATCH' | 'RATE_DIFFERS_FROM_MASTER' | 'ITC_INELIGIBLE' | 'SUPPLIER_UNREGISTERED';
  message: string;
}

interface PreparedPurchaseLine {
  lineNumber: number;
  productId: string;
  productName: string;
  hsnCode: string;
  quantity: Prisma.Decimal;
  unitId: string;
  unitName: string;
  uqc: string;
  conversionToBase: Prisma.Decimal;
  baseQuantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  computed: ComputedLine;
  chargeShare: Prisma.Decimal;
  landedCostPerBaseUnit: Prisma.Decimal;
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

/**
 * Resolves masters and computes every amount. Read-only, so anything that can
 * fail surfaces before the transaction opens and before a number is consumed.
 */
async function preparePurchase(businessId: string, input: CreatePurchaseInput) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business not found');

  const party = await prisma.party.findFirst({ where: { id: input.partyId, businessId } });
  if (!party) throw notFound('Supplier not found');
  if (!party.isActive) throw badRequest(`"${party.displayName}" is inactive`);
  if (party.partyType === 'CUSTOMER') {
    throw badRequest(`"${party.displayName}" is a customer, not a supplier`);
  }

  const supplyType: SupplyType = resolveSupplyType(business.stateCode, party.stateCode);
  const itcEligible = input.itcEligible ?? true;
  const warnings: PurchaseWarning[] = [];

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId },
    include: { hsnCode: true, baseUnit: true, productUnits: { include: { unit: true } } },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));
  const missing = productIds.filter((id) => !productMap.has(id));
  if (missing.length > 0) throw notFound(`Unknown product(s): ${missing.join(', ')}`);

  // Master rates as at the bill date — used as the default and as the thing we
  // compare the supplier's charged rate against.
  const rateRows = await prisma.hsnTaxRate.findMany({
    where: {
      hsnCodeId: { in: [...new Set(products.map((p) => p.hsnCodeId))] },
      effectiveFrom: { lte: input.supplierInvoiceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.supplierInvoiceDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const rateMap = new Map<string, (typeof rateRows)[number]>();
  for (const row of rateRows) if (!rateMap.has(row.hsnCodeId)) rateMap.set(row.hsnCodeId, row);

  // ---- Line values and tax ----
  const partial: Array<Omit<PreparedPurchaseLine, 'chargeShare' | 'landedCostPerBaseUnit'>> = [];

  for (const [index, item] of input.items.entries()) {
    const lineNumber = index + 1;
    const product = productMap.get(item.productId)!;

    const quantity = round3(D(item.quantity));

    // Mills bill in kg; the shop counts stock in reams. This is where that
    // conversion is applied.
    const unitId =
      item.unitId ??
      product.defaultPurchaseUnitId ??
      product.productUnits.find((pu) => pu.isPurchaseDefault)?.unitId ??
      product.baseUnitId;

    let conversionToBase: Prisma.Decimal;
    let unitName: string;
    let uqc: string;

    if (unitId === product.baseUnitId) {
      conversionToBase = D(1);
      unitName = product.baseUnit.name;
      uqc = product.baseUnit.uqc;
    } else {
      const productUnit = product.productUnits.find((pu) => pu.unitId === unitId);
      if (!productUnit) {
        throw badRequest(
          `Line ${lineNumber}: "${product.name}" has no conversion defined for the billed unit. ` +
            'Add the kg conversion on the product first.',
        );
      }
      conversionToBase = D(productUnit.conversionToBase);
      unitName = productUnit.unit.name;
      uqc = productUnit.unit.uqc;
    }

    const baseQuantity = round3(quantity.times(conversionToBase));
    const master = rateMap.get(product.hsnCodeId);

    // The supplier's charged rate governs the credit we can claim, so an
    // explicit rate wins over our master. A difference is worth flagging
    // though — it usually means one of the two is out of date.
    const gstRate = item.gstRate !== undefined ? D(item.gstRate) : master ? D(master.gstRate) : null;
    const cessRate = item.cessRate !== undefined ? D(item.cessRate) : master ? D(master.cessRate) : ZERO();

    if (gstRate === null) {
      throw badRequest(
        `Line ${lineNumber}: no GST rate configured for HSN ${product.hsnCode.code}, and none given on the line.`,
      );
    }
    if (master && item.gstRate !== undefined && !D(master.gstRate).equals(gstRate)) {
      warnings.push({
        code: 'RATE_DIFFERS_FROM_MASTER',
        message:
          `Line ${lineNumber}: the bill charges ${gstRate.toString()}% on "${product.name}" but the ` +
          `HSN master says ${D(master.gstRate).toString()}%. Using the bill's rate.`,
      });
    }

    const computed = computeLine(
      {
        quantity,
        rate: D(item.rate),
        ...(item.discountAmount !== undefined ? { discountAmount: D(item.discountAmount) } : {}),
        ...(item.discountPercent !== undefined ? { discountPercent: D(item.discountPercent) } : {}),
      },
      { gstRate, cessRate },
      supplyType,
    );

    if (computed.taxableValue.isNegative()) {
      throw badRequest(`Line ${lineNumber}: discount is larger than the line amount`);
    }

    partial.push({
      lineNumber,
      productId: product.id,
      productName: product.name,
      hsnCode: formatHsn(product.hsnCode.code, business.hsnDigits),
      quantity,
      unitId,
      unitName,
      uqc,
      conversionToBase,
      baseQuantity,
      rate: D(item.rate),
      computed,
    });
  }

  const totals = computeInvoiceTotals(
    partial.map((l) => l.computed),
    {
      ...(input.freightCharges !== undefined ? { freightCharges: D(input.freightCharges) } : {}),
      ...(input.otherCharges !== undefined ? { otherCharges: D(input.otherCharges) } : {}),
    },
  );

  // ---- Landed cost: freight raises what the goods actually cost ----
  const totalCharges = totals.freightCharges.plus(totals.otherCharges);
  const shares = apportionCharges(totalCharges, partial.map((l) => l.computed.taxableValue));

  const lines: PreparedPurchaseLine[] = partial.map((line, index) => {
    const chargeShare = shares[index] ?? ZERO();
    const taxAmount = line.computed.cgstAmount
      .plus(line.computed.sgstAmount)
      .plus(line.computed.igstAmount)
      .plus(line.computed.cessAmount);

    return {
      ...line,
      chargeShare,
      landedCostPerBaseUnit: landedCostPerBaseUnit({
        taxableValue: line.computed.taxableValue,
        chargeShare,
        taxAmount,
        baseQuantity: line.baseQuantity,
        itcEligible,
      }),
    };
  });

  // ---- Reconciliation against the paper bill ----
  const reconciliation = reconcileWithSupplierTotal(totals.grandTotal, input.supplierGrandTotal);
  if (reconciliation && !reconciliation.matches) {
    warnings.push({
      code: 'SUPPLIER_TOTAL_MISMATCH',
      message:
        `We computed ₹${totals.grandTotal.toString()} but the bill says ` +
        `₹${D(input.supplierGrandTotal!).toString()} — a difference of ₹${reconciliation.difference.toString()}. ` +
        'Check the rates and charges before filing.',
    });
  }

  if (!party.gstin) {
    warnings.push({
      code: 'SUPPLIER_UNREGISTERED',
      message: `"${party.displayName}" has no GSTIN, so there is no input credit to claim on this bill.`,
    });
  }
  if (!itcEligible) {
    warnings.push({
      code: 'ITC_INELIGIBLE',
      message: 'Input credit is marked unavailable, so the GST on this bill is included in stock cost.',
    });
  }

  return { business, party, supplyType, itcEligible, lines, totals, warnings, reconciliation };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPurchase(
  businessId: string,
  userId: string,
  input: CreatePurchaseInput,
  ctx: RequestContext,
) {
  const duplicate = await prisma.purchaseInvoice.findFirst({
    where: {
      businessId,
      partyId: input.partyId,
      supplierInvoiceNumber: input.supplierInvoiceNumber,
    },
    select: { id: true, purchaseNumber: true },
  });
  if (duplicate) {
    // The single most common data-entry error in purchases: the same bill keyed
    // twice, which doubles stock and doubles the credit claimed.
    throw conflict(
      `Bill ${input.supplierInvoiceNumber} from this supplier is already entered as ${duplicate.purchaseNumber}`,
    );
  }

  const prepared = await preparePurchase(businessId, input);
  const { business, party, supplyType, itcEligible, lines, totals } = prepared;
  const shouldIssue = input.issue !== false;
  const financialYear = financialYearOf(input.supplierInvoiceDate, business.fyStartMonth);

  const purchase = await prisma.$transaction(
    async (tx) => {
      const { number: purchaseNumber } = await allocateDocumentNumber(
        tx,
        businessId,
        'PURCHASE_INVOICE',
        financialYear,
      );

      const created = await tx.purchaseInvoice.create({
        data: {
          businessId,
          purchaseNumber,
          supplierInvoiceNumber: input.supplierInvoiceNumber,
          supplierInvoiceDate: input.supplierInvoiceDate,
          status: shouldIssue ? 'ISSUED' : 'DRAFT',

          partyId: party.id,
          partyName: party.displayName,
          partyGstin: party.gstin,
          partyStateCode: party.stateCode,

          supplyType,
          reverseCharge: input.reverseCharge ?? false,

          subtotal: totals.subtotal,
          totalDiscount: totals.totalDiscount,
          taxableValue: totals.taxableValue,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          freightCharges: totals.freightCharges,
          otherCharges: totals.otherCharges,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,

          itcEligible,
          notes: input.notes ?? null,
          createdById: userId,
          issuedAt: shouldIssue ? new Date() : null,

          items: {
            create: lines.map((line) => ({
              lineNumber: line.lineNumber,
              productId: line.productId,
              productName: line.productName,
              hsnCode: line.hsnCode,
              quantity: line.quantity,
              unitId: line.unitId,
              unitName: line.unitName,
              uqc: line.uqc,
              conversionToBase: line.conversionToBase,
              baseQuantity: line.baseQuantity,
              rate: line.rate,
              discountPercent: line.computed.discountPercent,
              discountAmount: line.computed.discountAmount,
              taxableValue: line.computed.taxableValue,
              cgstRate: line.computed.cgstRate,
              cgstAmount: line.computed.cgstAmount,
              sgstRate: line.computed.sgstRate,
              sgstAmount: line.computed.sgstAmount,
              igstRate: line.computed.igstRate,
              igstAmount: line.computed.igstAmount,
              cessRate: line.computed.cessRate,
              cessAmount: line.computed.cessAmount,
              lineTotal: line.computed.lineTotal,
              landedCostPerBaseUnit: line.landedCostPerBaseUnit,
            })),
          },
        },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });

      if (shouldIssue) {
        await applyPurchaseSideEffects(tx, {
          businessId,
          userId,
          purchase: created,
          lines,
          party,
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: shouldIssue ? 'purchase.create' : 'purchase.draft',
          entityType: 'PurchaseInvoice',
          entityId: created.id,
          after: {
            purchaseNumber,
            supplierInvoiceNumber: input.supplierInvoiceNumber,
            party: party.displayName,
            grandTotal: totals.grandTotal.toString(),
            itcEligible,
          },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 },
  );

  return { purchase, warnings: prepared.warnings, reconciliation: prepared.reconciliation };
}

/**
 * Stock in, at landed cost, plus the supplier ledger credit.
 */
async function applyPurchaseSideEffects(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    userId: string;
    purchase: { id: string; purchaseNumber: string; supplierInvoiceDate: Date; grandTotal: Prisma.Decimal };
    lines: PreparedPurchaseLine[];
    party: { id: string; displayName: string; openingBalance: Prisma.Decimal };
  },
) {
  const { businessId, userId, purchase, lines, party } = args;

  for (const line of lines) {
    // ── Lock, then read, then write ───────────────────────────────────────
    // The moving average needs the *current* quantity and cost, and writing the
    // new average is a blind write — so two concurrent receipts of the same
    // product would lose one update. This upsert's UPDATE takes the row lock
    // and returns the pre-change values under it; the real write follows.
    const locked = await tx.productStock.upsert({
      where: { productId: line.productId },
      create: {
        productId: line.productId,
        businessId,
        quantityOnHand: 0,
        avgCostPerBaseUnit: 0,
        lastMovementAt: purchase.supplierInvoiceDate,
      },
      update: { lastMovementAt: purchase.supplierInvoiceDate },
    });

    const newAverage = movingAverageCost(
      locked.quantityOnHand,
      locked.avgCostPerBaseUnit,
      line.baseQuantity,
      line.landedCostPerBaseUnit,
    );

    const updated = await tx.productStock.update({
      where: { productId: line.productId },
      data: {
        quantityOnHand: { increment: line.baseQuantity },
        avgCostPerBaseUnit: newAverage,
      },
    });

    await tx.stockMovement.create({
      data: {
        businessId,
        productId: line.productId,
        movementType: 'PURCHASE_IN',
        movementDate: purchase.supplierInvoiceDate,
        baseQuantity: line.baseQuantity,
        ratePerBaseUnit: line.landedCostPerBaseUnit,
        balanceAfter: updated.quantityOnHand,
        referenceType: 'PURCHASE_INVOICE',
        referenceId: purchase.id,
        referenceNumber: purchase.purchaseNumber,
        createdById: userId,
      },
    });
  }

  // ── Ledger: we now owe the supplier ──────────────────────────────────────
  // Sign convention is "positive = they owe us", so a purchase pushes the
  // balance negative.
  const balance = await tx.partyBalance.upsert({
    where: { partyId: party.id },
    create: {
      partyId: party.id,
      currentBalance: D(party.openingBalance).minus(purchase.grandTotal),
      lastEntryAt: purchase.supplierInvoiceDate,
    },
    update: {
      currentBalance: { decrement: purchase.grandTotal },
      lastEntryAt: purchase.supplierInvoiceDate,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      businessId,
      partyId: party.id,
      entryDate: purchase.supplierInvoiceDate,
      voucherType: 'PURCHASE_INVOICE',
      voucherId: purchase.id,
      voucherNumber: purchase.purchaseNumber,
      debit: 0,
      credit: purchase.grandTotal,
      runningBalance: balance.currentBalance,
      narration: `Purchase ${purchase.purchaseNumber}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Reverses a purchase.
 *
 * Note the cost side: the moving average is *not* unwound, because the average
 * has since been blended with other receipts and there is no arithmetic that
 * recovers the earlier figure. Quantity is reversed exactly; valuation drifts
 * slightly and is corrected by the next receipt. A stock adjustment is the tool
 * if the drift matters.
 */
export async function cancelPurchase(
  businessId: string,
  userId: string,
  purchaseId: string,
  reason: string,
  ctx: RequestContext,
) {
  const purchase = await prisma.purchaseInvoice.findFirst({
    where: { id: purchaseId, businessId },
    include: { items: true, allocations: true },
  });
  if (!purchase) throw notFound('Purchase not found');
  if (purchase.status === 'CANCELLED') throw conflict('Purchase is already cancelled');

  if (purchase.status === 'DRAFT') {
    await prisma.purchaseInvoice.delete({ where: { id: purchaseId } });
    return { cancelled: true, deleted: true };
  }

  if (purchase.allocations.length > 0) {
    throw conflict('Payments are allocated to this bill. Unallocate them first.');
  }
  if (purchase.itcClaimed) {
    throw conflict(
      `Input credit was claimed in ${purchase.itcClaimedIn}. Reverse the claim before cancelling.`,
    );
  }

  const cancelledAt = new Date();

  await prisma.$transaction(
    async (tx) => {
      for (const item of purchase.items) {
        const updated = await tx.productStock.update({
          where: { productId: item.productId },
          data: { quantityOnHand: { decrement: item.baseQuantity }, lastMovementAt: cancelledAt },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            productId: item.productId,
            movementType: 'ADJUSTMENT_OUT',
            movementDate: cancelledAt,
            baseQuantity: D(item.baseQuantity).negated(),
            ratePerBaseUnit: item.landedCostPerBaseUnit,
            balanceAfter: updated.quantityOnHand,
            referenceType: 'PURCHASE_INVOICE_CANCELLED',
            referenceId: purchase.id,
            referenceNumber: purchase.purchaseNumber,
            notes: `Cancellation of ${purchase.purchaseNumber}: ${reason}`,
            createdById: userId,
          },
        });
      }

      const balance = await tx.partyBalance.update({
        where: { partyId: purchase.partyId },
        data: { currentBalance: { increment: purchase.grandTotal }, lastEntryAt: cancelledAt },
      });

      await tx.ledgerEntry.create({
        data: {
          businessId,
          partyId: purchase.partyId,
          entryDate: cancelledAt,
          voucherType: 'ADJUSTMENT',
          voucherId: purchase.id,
          voucherNumber: purchase.purchaseNumber,
          debit: purchase.grandTotal,
          credit: 0,
          runningBalance: balance.currentBalance,
          narration: `Cancellation of purchase ${purchase.purchaseNumber}: ${reason}`,
        },
      });

      await tx.purchaseInvoice.update({
        where: { id: purchaseId },
        data: { status: 'CANCELLED' },
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'purchase.cancel',
          entityType: 'PurchaseInvoice',
          entityId: purchaseId,
          after: { reason },
          ipAddress: ctx.ipAddress ?? null,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
  );

  return { cancelled: true, deleted: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function previewPurchase(businessId: string, input: CreatePurchaseInput) {
  const prepared = await preparePurchase(businessId, input);
  return {
    supplyType: prepared.supplyType,
    party: { id: prepared.party.id, displayName: prepared.party.displayName, gstin: prepared.party.gstin },
    lines: prepared.lines.map((l) => ({
      lineNumber: l.lineNumber,
      productName: l.productName,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      unitName: l.unitName,
      baseQuantity: l.baseQuantity,
      rate: l.rate,
      chargeShare: l.chargeShare,
      landedCostPerBaseUnit: l.landedCostPerBaseUnit,
      ...l.computed,
    })),
    totals: prepared.totals,
    itcEligible: prepared.itcEligible,
    inputTaxCredit: prepared.itcEligible
      ? round2(
          prepared.totals.totalCgst
            .plus(prepared.totals.totalSgst)
            .plus(prepared.totals.totalIgst),
        )
      : ZERO(),
    reconciliation: prepared.reconciliation,
    warnings: prepared.warnings,
  };
}

export async function getPurchase(businessId: string, purchaseId: string) {
  const purchase = await prisma.purchaseInvoice.findFirst({
    where: { id: purchaseId, businessId },
    include: {
      items: { orderBy: { lineNumber: 'asc' } },
      party: { select: { id: true, displayName: true, gstin: true, phone: true } },
      allocations: {
        include: { payment: { select: { id: true, voucherNumber: true, paymentDate: true, mode: true } } },
      },
    },
  });
  if (!purchase) throw notFound('Purchase not found');

  return {
    ...purchase,
    amountDue: D(purchase.grandTotal).minus(D(purchase.amountPaid)),
    inputTaxCredit: purchase.itcEligible
      ? round2(D(purchase.totalCgst).plus(D(purchase.totalSgst)).plus(D(purchase.totalIgst)))
      : ZERO(),
  };
}

export async function listPurchases(businessId: string, filter: ListPurchasesFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.PurchaseInvoiceWhereInput = {
    businessId,
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.fromDate || filter.toDate
      ? {
          supplierInvoiceDate: {
            ...(filter.fromDate ? { gte: filter.fromDate } : {}),
            ...(filter.toDate ? { lte: filter.toDate } : {}),
          },
        }
      : {}),
    ...(filter.unpaidOnly
      ? { grandTotal: { gt: prisma.purchaseInvoice.fields.amountPaid }, status: 'ISSUED' as const }
      : {}),
    ...(filter.itcPendingOnly
      ? { itcEligible: true, itcClaimed: false, status: 'ISSUED' as const }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { purchaseNumber: { contains: filter.search, mode: 'insensitive' } },
            { supplierInvoiceNumber: { contains: filter.search, mode: 'insensitive' } },
            { partyName: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total, aggregate] = await Promise.all([
    prisma.purchaseInvoice.findMany({
      where,
      orderBy: [{ supplierInvoiceDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        purchaseNumber: true,
        supplierInvoiceNumber: true,
        supplierInvoiceDate: true,
        status: true,
        partyId: true,
        partyName: true,
        supplyType: true,
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        grandTotal: true,
        amountPaid: true,
        itcEligible: true,
        itcClaimed: true,
        itcClaimedIn: true,
      },
    }),
    prisma.purchaseInvoice.count({ where }),
    prisma.purchaseInvoice.aggregate({ where, _sum: { grandTotal: true, taxableValue: true } }),
  ]);

  return {
    purchases: rows.map((r) => ({
      ...r,
      amountDue: D(r.grandTotal).minus(D(r.amountPaid)),
      inputTaxCredit: r.itcEligible
        ? round2(D(r.totalCgst).plus(D(r.totalSgst)).plus(D(r.totalIgst)))
        : ZERO(),
    })),
    total,
    page,
    pageSize,
    totalValue: D(aggregate._sum.grandTotal ?? 0),
    totalTaxable: D(aggregate._sum.taxableValue ?? 0),
  };
}

/** Purchase history for one product — what you actually paid, over time. */
export async function getProductPurchaseHistory(businessId: string, productId: string, limit = 20) {
  const items = await prisma.purchaseInvoiceItem.findMany({
    where: { productId, invoice: { businessId, status: 'ISSUED' } },
    include: {
      invoice: {
        select: { id: true, purchaseNumber: true, supplierInvoiceDate: true, partyName: true },
      },
    },
    orderBy: { invoice: { supplierInvoiceDate: 'desc' } },
    take: limit,
  });

  return {
    purchases: items.map((i) => ({
      purchaseId: i.invoice.id,
      purchaseNumber: i.invoice.purchaseNumber,
      date: i.invoice.supplierInvoiceDate,
      supplier: i.invoice.partyName,
      quantity: D(i.quantity),
      unitName: i.unitName,
      rate: D(i.rate),
      landedCostPerBaseUnit: i.landedCostPerBaseUnit ? D(i.landedCostPerBaseUnit) : null,
    })),
    averageRate:
      items.length > 0
        ? round2(sum(items.map((i) => D(i.rate))).dividedBy(items.length))
        : ZERO(),
  };
}
