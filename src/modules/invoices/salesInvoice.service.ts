import { Prisma, type InvoiceStatus, type SupplyType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { D, round2, round3, sum, ZERO } from '../../lib/money.js';
import { financialYearOf } from '../../lib/financialYear.js';
import { resolveSupplyType } from '../../lib/gstin.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { amountInWords } from './amountInWords.js';
import { allocateDocumentNumber } from './numbering.js';
import { buildHsnSummary, computeInvoiceTotals, computeLine, formatHsn, type ComputedLine } from './tax.js';
import type { RequestContext } from '../auth/auth.service.js';

export interface SalesInvoiceItemInput {
  productId: string;
  quantity: number | string;
  /// Unit the quantity is expressed in. Defaults to the product's sales unit.
  unitId?: string;
  /// Omit to resolve from the party's negotiated rate, then the product default.
  rate?: number | string;
  discountPercent?: number | string;
  discountAmount?: number | string;
  description?: string;
}

export interface CreateSalesInvoiceInput {
  partyId: string;
  invoiceDate?: string | Date;
  dueDate?: string | Date;
  items: SalesInvoiceItemInput[];
  freightCharges?: number | string;
  otherCharges?: number | string;
  reverseCharge?: boolean;
  notes?: string;
  transportName?: string;
  vehicleNumber?: string;
  createdViaVoice?: boolean;
  voiceSessionId?: string;
  /// false leaves the invoice as an editable DRAFT with no number, no stock
  /// movement and no ledger entry.
  issue?: boolean;
}

export interface IssueWarning {
  code: 'NEGATIVE_STOCK' | 'EWAY_BILL_REQUIRED' | 'CREDIT_LIMIT_EXCEEDED' | 'PARTY_UNREGISTERED';
  message: string;
}

/// Prepared line, ready to persist. Resolved against masters before any write.
interface PreparedLine {
  lineNumber: number;
  productId: string;
  productName: string;
  hsnCode: string;
  description: string | null;
  quantity: Prisma.Decimal;
  unitId: string;
  unitName: string;
  uqc: string;
  conversionToBase: Prisma.Decimal;
  baseQuantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  computed: ComputedLine;
  costPerBaseUnit: Prisma.Decimal | null;
}

// ---------------------------------------------------------------------------
// Preparation — everything that can fail, before anything is written
// ---------------------------------------------------------------------------

/**
 * Resolves masters, rates and tax, and computes every amount.
 *
 * Deliberately read-only. All the ways an invoice can be invalid — unknown
 * product, missing conversion factor, no GST rate configured for the invoice
 * date — surface here, before the transaction opens and before a number is
 * consumed. That is what keeps numbering gap-free.
 */
async function prepareInvoice(
  businessId: string,
  input: CreateSalesInvoiceInput,
) {
  if (!input.items || input.items.length === 0) {
    throw badRequest('An invoice needs at least one item');
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business not found');

  const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : new Date();
  if (Number.isNaN(invoiceDate.getTime())) throw badRequest('Invalid invoice date');

  const party = await prisma.party.findFirst({
    where: { id: input.partyId, businessId },
  });
  if (!party) throw notFound('Customer not found');
  if (!party.isActive) throw badRequest(`Customer "${party.displayName}" is inactive`);
  if (party.partyType === 'SUPPLIER') {
    throw badRequest(`"${party.displayName}" is a supplier, not a customer`);
  }

  // The single decision that drives the whole tax split. Derived, never asked.
  const supplyType: SupplyType = resolveSupplyType(business.stateCode, party.stateCode);

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId },
    include: {
      hsnCode: true,
      baseUnit: true,
      productUnits: { include: { unit: true } },
      stock: true,
    },
  });

  const productMap = new Map(products.map((p) => [p.id, p]));
  const missing = productIds.filter((id) => !productMap.has(id));
  if (missing.length > 0) throw notFound(`Unknown product(s): ${missing.join(', ')}`);

  // Tax rates as at the invoice date — not "current" rates. A backdated invoice
  // must carry the rate that applied on its own date.
  const hsnCodeIds = [...new Set(products.map((p) => p.hsnCodeId))];
  const rateRows = await prisma.hsnTaxRate.findMany({
    where: {
      hsnCodeId: { in: hsnCodeIds },
      effectiveFrom: { lte: invoiceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: invoiceDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const rateMap = new Map<string, (typeof rateRows)[number]>();
  for (const row of rateRows) {
    if (!rateMap.has(row.hsnCodeId)) rateMap.set(row.hsnCodeId, row);
  }

  // Party-specific negotiated rates.
  const partyRates = await prisma.partyRate.findMany({
    where: {
      partyId: party.id,
      productId: { in: productIds },
      effectiveFrom: { lte: invoiceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: invoiceDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  const lines: PreparedLine[] = [];
  const warnings: IssueWarning[] = [];

  for (const [index, item] of input.items.entries()) {
    const lineNumber = index + 1;
    const product = productMap.get(item.productId)!;

    const quantity = round3(D(item.quantity));
    if (quantity.lessThanOrEqualTo(0)) {
      throw badRequest(`Line ${lineNumber}: quantity must be greater than zero`);
    }

    // ---- Unit and conversion ----
    const unitId =
      item.unitId ??
      product.defaultSaleUnitId ??
      product.productUnits.find((pu) => pu.isSalesDefault)?.unitId ??
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
          `Line ${lineNumber}: "${product.name}" has no conversion defined for the selected unit. ` +
            `Add it under the product's units (this is the reams↔kg factor).`,
        );
      }
      conversionToBase = D(productUnit.conversionToBase);
      unitName = productUnit.unit.name;
      uqc = productUnit.unit.uqc;
    }

    if (conversionToBase.lessThanOrEqualTo(0)) {
      throw badRequest(`Line ${lineNumber}: conversion factor for "${product.name}" must be positive`);
    }

    const baseQuantity = round3(quantity.times(conversionToBase));

    // ---- Rate: explicit > party rate for this unit > product default ----
    let rate: Prisma.Decimal;
    if (item.rate !== undefined && item.rate !== null && item.rate !== '') {
      rate = D(item.rate);
    } else {
      const negotiated = partyRates.find(
        (pr) => pr.productId === product.id && pr.unitId === unitId,
      );
      if (negotiated) {
        rate = D(negotiated.rate);
      } else if (product.defaultSaleRate !== null && unitId === (product.defaultSaleUnitId ?? product.baseUnitId)) {
        rate = D(product.defaultSaleRate);
      } else {
        throw badRequest(
          `Line ${lineNumber}: no rate given for "${product.name}" and no default rate is set for ${unitName}`,
        );
      }
    }
    if (rate.isNegative()) throw badRequest(`Line ${lineNumber}: rate cannot be negative`);

    // ---- Tax ----
    const taxRate = rateMap.get(product.hsnCodeId);
    if (!taxRate) {
      throw badRequest(
        `No GST rate is configured for HSN ${product.hsnCode.code} as at ` +
          `${invoiceDate.toISOString().slice(0, 10)}. Add it under HSN settings before billing.`,
      );
    }

    const computed = computeLine(
      {
        quantity,
        rate,
        ...(item.discountAmount !== undefined ? { discountAmount: D(item.discountAmount) } : {}),
        ...(item.discountPercent !== undefined ? { discountPercent: D(item.discountPercent) } : {}),
      },
      { gstRate: D(taxRate.gstRate), cessRate: D(taxRate.cessRate) },
      supplyType,
    );

    if (computed.taxableValue.isNegative()) {
      throw badRequest(`Line ${lineNumber}: discount is larger than the line amount`);
    }

    // ---- Stock warning (not a hard block — he bills before entering purchases) ----
    const onHand = product.stock ? D(product.stock.quantityOnHand) : ZERO();
    if (onHand.lessThan(baseQuantity)) {
      warnings.push({
        code: 'NEGATIVE_STOCK',
        message:
          `"${product.name}" will go negative: ${onHand.toString()} ${product.baseUnit.symbol} on hand, ` +
          `${baseQuantity.toString()} being sold. Enter the purchase bill to correct it.`,
      });
    }

    lines.push({
      lineNumber,
      productId: product.id,
      productName: product.name,
      hsnCode: formatHsn(product.hsnCode.code, business.hsnDigits),
      description: item.description ?? null,
      quantity,
      unitId,
      unitName,
      uqc,
      conversionToBase,
      baseQuantity,
      rate,
      computed,
      costPerBaseUnit: product.stock ? D(product.stock.avgCostPerBaseUnit) : null,
    });
  }

  const totals = computeInvoiceTotals(
    lines.map((l) => l.computed),
    {
      ...(input.freightCharges !== undefined ? { freightCharges: D(input.freightCharges) } : {}),
      ...(input.otherCharges !== undefined ? { otherCharges: D(input.otherCharges) } : {}),
    },
  );

  // ---- Cost of goods, for margin reporting ----
  const costOfGoods = lines.every((l) => l.costPerBaseUnit !== null)
    ? round2(sum(lines.map((l) => l.baseQuantity.times(l.costPerBaseUnit!))))
    : null;

  // ---- E-way bill ----
  // Interstate movement above the threshold needs one. Intra-state rules vary
  // by state, so we only flag the interstate case automatically.
  const ewayBillRequired =
    supplyType === 'INTER_STATE' && totals.grandTotal.greaterThanOrEqualTo(D(business.ewayBillThreshold));
  if (ewayBillRequired) {
    warnings.push({
      code: 'EWAY_BILL_REQUIRED',
      message:
        `This is an interstate supply of ₹${totals.grandTotal.toString()}, above the ` +
        `₹${D(business.ewayBillThreshold).toString()} threshold. An e-way bill is required before the goods move.`,
    });
  }

  if (!party.gstin) {
    warnings.push({
      code: 'PARTY_UNREGISTERED',
      message: `"${party.displayName}" has no GSTIN — this will be filed as a B2C supply.`,
    });
  }

  if (party.creditLimit) {
    const outstanding = await prisma.partyBalance.findUnique({ where: { partyId: party.id } });
    const projected = D(outstanding?.currentBalance ?? party.openingBalance).plus(totals.grandTotal);
    if (projected.greaterThan(D(party.creditLimit))) {
      warnings.push({
        code: 'CREDIT_LIMIT_EXCEEDED',
        message:
          `"${party.displayName}" would owe ₹${projected.toString()}, over their ` +
          `₹${D(party.creditLimit).toString()} credit limit.`,
      });
    }
  }

  return {
    business,
    party,
    supplyType,
    invoiceDate,
    lines,
    totals,
    costOfGoods,
    ewayBillRequired,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSalesInvoice(
  businessId: string,
  userId: string,
  input: CreateSalesInvoiceInput,
  ctx: RequestContext,
) {
  const prepared = await prepareInvoice(businessId, input);
  const { business, party, supplyType, invoiceDate, lines, totals } = prepared;
  const shouldIssue = input.issue !== false;
  const financialYear = financialYearOf(invoiceDate, business.fyStartMonth);

  const invoice = await prisma.$transaction(
    async (tx) => {
      // Number allocation goes last among the things that can fail, and inside
      // the transaction, so a rollback returns the number to the pool.
      let invoiceNumber: string | null = null;
      if (shouldIssue) {
        const allocated = await allocateDocumentNumber(tx, businessId, 'SALES_INVOICE', financialYear);
        invoiceNumber = allocated.number;
      }

      const created = await tx.salesInvoice.create({
        data: {
          businessId,
          invoiceNumber,
          financialYear,
          status: shouldIssue ? 'ISSUED' : 'DRAFT',
          invoiceDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,

          partyId: party.id,
          // Snapshot: the invoice must reprint identically even if the customer
          // later changes address or GSTIN.
          partyName: party.displayName,
          partyGstin: party.gstin,
          partyAddress: [party.addressLine1, party.addressLine2, party.city, party.pincode]
            .filter(Boolean)
            .join(', ') || null,
          partyStateCode: party.stateCode,
          partyPhone: party.phone,

          supplyType,
          placeOfSupply: party.stateCode,
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
          amountInWords: amountInWords(totals.grandTotal),
          costOfGoods: prepared.costOfGoods,

          notes: input.notes ?? null,
          transportName: input.transportName ?? null,
          vehicleNumber: input.vehicleNumber ?? null,

          createdById: userId,
          createdViaVoice: input.createdViaVoice ?? false,
          voiceSessionId: input.voiceSessionId ?? null,
          issuedAt: shouldIssue ? new Date() : null,

          items: {
            create: lines.map((line) => ({
              lineNumber: line.lineNumber,
              productId: line.productId,
              productName: line.productName,
              hsnCode: line.hsnCode,
              description: line.description,
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
              costPerBaseUnit: line.costPerBaseUnit,
            })),
          },
        },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });

      // A draft moves no goods and owes no money, so nothing else happens yet.
      if (shouldIssue) {
        await applyIssueSideEffects(tx, {
          businessId,
          userId,
          invoice: created,
          lines,
          party,
          ewayBillRequired: prepared.ewayBillRequired,
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: shouldIssue ? 'sales_invoice.issue' : 'sales_invoice.draft',
          entityType: 'SalesInvoice',
          entityId: created.id,
          after: {
            invoiceNumber: created.invoiceNumber,
            partyName: created.partyName,
            grandTotal: created.grandTotal.toString(),
          },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 },
  );

  return {
    invoice,
    warnings: prepared.warnings,
    hsnSummary: buildHsnSummary(
      lines.map((l) => ({ ...l.computed, hsnCode: l.hsnCode, uqc: l.uqc, quantity: l.quantity })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Issue side effects — stock, ledger, e-way bill
// ---------------------------------------------------------------------------

/**
 * Everything that happens the moment an invoice becomes real. Runs inside the
 * caller's transaction — if any of it fails, the invoice does not exist and the
 * number is returned to the sequence.
 */
async function applyIssueSideEffects(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    userId: string;
    invoice: { id: string; invoiceNumber: string | null; invoiceDate: Date; grandTotal: Prisma.Decimal };
    lines: PreparedLine[];
    party: { id: string; displayName: string; openingBalance: Prisma.Decimal };
    ewayBillRequired: boolean;
  },
) {
  const { businessId, userId, invoice, lines, party } = args;

  // ---- Stock out ----
  for (const line of lines) {
    // upsert with `decrement` compiles to an atomic
    // `SET "quantityOnHand" = "quantityOnHand" - $1`, so two concurrent sales of
    // the same product cannot lose an update.
    const stock = await tx.productStock.upsert({
      where: { productId: line.productId },
      create: {
        productId: line.productId,
        businessId,
        quantityOnHand: line.baseQuantity.negated(),
        avgCostPerBaseUnit: 0,
        lastMovementAt: invoice.invoiceDate,
      },
      update: {
        quantityOnHand: { decrement: line.baseQuantity },
        lastMovementAt: invoice.invoiceDate,
      },
    });

    await tx.stockMovement.create({
      data: {
        businessId,
        productId: line.productId,
        movementType: 'SALE_OUT',
        movementDate: invoice.invoiceDate,
        baseQuantity: line.baseQuantity.negated(),
        ratePerBaseUnit: line.costPerBaseUnit,
        balanceAfter: stock.quantityOnHand,
        referenceType: 'SALES_INVOICE',
        referenceId: invoice.id,
        referenceNumber: invoice.invoiceNumber,
        createdById: userId,
      },
    });
  }

  // ---- Ledger: the customer now owes us the grand total ----
  const balance = await tx.partyBalance.upsert({
    where: { partyId: party.id },
    create: {
      partyId: party.id,
      // First movement for this party — seed from the opening balance captured
      // when they were migrated off the old software.
      currentBalance: D(party.openingBalance).plus(invoice.grandTotal),
      lastEntryAt: invoice.invoiceDate,
    },
    update: {
      currentBalance: { increment: invoice.grandTotal },
      lastEntryAt: invoice.invoiceDate,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      businessId,
      partyId: party.id,
      entryDate: invoice.invoiceDate,
      voucherType: 'SALES_INVOICE',
      voucherId: invoice.id,
      voucherNumber: invoice.invoiceNumber,
      debit: invoice.grandTotal,
      credit: 0,
      runningBalance: balance.currentBalance,
      narration: `Sales invoice ${invoice.invoiceNumber}`,
    },
  });

  // ---- E-way bill placeholder, so it shows up on a worklist ----
  if (args.ewayBillRequired) {
    await tx.ewayBill.create({
      data: {
        businessId,
        salesInvoiceId: invoice.id,
        status: 'PENDING',
        supplyTypeCode: 'O', // Outward
        subSupplyType: '1', // Supply
        documentType: 'INV',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Issue an existing draft
// ---------------------------------------------------------------------------

export async function issueDraft(
  businessId: string,
  userId: string,
  invoiceId: string,
  ctx: RequestContext,
) {
  const draft = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, businessId },
    include: { items: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!draft) throw notFound('Invoice not found');
  if (draft.status !== 'DRAFT') throw conflict(`Invoice is already ${draft.status.toLowerCase()}`);

  // Re-run preparation against current masters so a draft written last week
  // picks up today's stock position and any corrected rate.
  const rebuilt = await prepareInvoice(businessId, {
    partyId: draft.partyId,
    invoiceDate: draft.invoiceDate,
    items: draft.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity.toString(),
      unitId: item.unitId,
      rate: item.rate.toString(),
      discountAmount: item.discountAmount.toString(),
    })),
    freightCharges: draft.freightCharges.toString(),
    otherCharges: draft.otherCharges.toString(),
  });

  const financialYear = financialYearOf(draft.invoiceDate, rebuilt.business.fyStartMonth);

  const issued = await prisma.$transaction(
    async (tx) => {
      const { number } = await allocateDocumentNumber(tx, businessId, 'SALES_INVOICE', financialYear);

      const updated = await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: {
          invoiceNumber: number,
          financialYear,
          status: 'ISSUED',
          issuedAt: new Date(),
          // Totals may have moved if a tax rate was corrected since the draft.
          subtotal: rebuilt.totals.subtotal,
          totalDiscount: rebuilt.totals.totalDiscount,
          taxableValue: rebuilt.totals.taxableValue,
          totalCgst: rebuilt.totals.totalCgst,
          totalSgst: rebuilt.totals.totalSgst,
          totalIgst: rebuilt.totals.totalIgst,
          totalCess: rebuilt.totals.totalCess,
          roundOff: rebuilt.totals.roundOff,
          grandTotal: rebuilt.totals.grandTotal,
          amountInWords: amountInWords(rebuilt.totals.grandTotal),
          costOfGoods: rebuilt.costOfGoods,
        },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });

      await applyIssueSideEffects(tx, {
        businessId,
        userId,
        invoice: updated,
        lines: rebuilt.lines,
        party: rebuilt.party,
        ewayBillRequired: rebuilt.ewayBillRequired,
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'sales_invoice.issue',
          entityType: 'SalesInvoice',
          entityId: invoiceId,
          before: { status: 'DRAFT' },
          after: { status: 'ISSUED', invoiceNumber: number },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 },
  );

  return { invoice: issued, warnings: rebuilt.warnings };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancels an issued invoice.
 *
 * This is deliberately narrow. Once a return has been filed, an invoice cannot
 * be cancelled — a credit note is the only correct instrument, and it is a
 * different document with its own number. Cancellation exists for the
 * same-session mistake: wrong customer, wrong quantity, caught immediately.
 *
 * The invoice number is *not* released. A gap in the sequence is a filing
 * problem; a cancelled number that stays on the books is not.
 */
export async function cancelSalesInvoice(
  businessId: string,
  userId: string,
  invoiceId: string,
  reason: string,
  ctx: RequestContext,
) {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, businessId },
    include: { items: true, allocations: true },
  });
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status === 'CANCELLED') throw conflict('Invoice is already cancelled');

  if (invoice.status === 'DRAFT') {
    // Nothing was ever posted — just delete it. No number was consumed.
    await prisma.$transaction([
      prisma.salesInvoice.delete({ where: { id: invoiceId } }),
      prisma.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'sales_invoice.delete_draft',
          entityType: 'SalesInvoice',
          entityId: invoiceId,
          before: { status: 'DRAFT', grandTotal: invoice.grandTotal.toString() },
          ipAddress: ctx.ipAddress ?? null,
        },
      }),
    ]);
    return { cancelled: true, deleted: true };
  }

  if (invoice.allocations.length > 0) {
    throw conflict(
      'Payments have been allocated to this invoice. Unallocate them first, or issue a credit note instead.',
    );
  }

  const cancelledAt = new Date();

  await prisma.$transaction(
    async (tx) => {
      // ---- Reverse stock ----
      for (const item of invoice.items) {
        const stock = await tx.productStock.update({
          where: { productId: item.productId },
          data: {
            quantityOnHand: { increment: item.baseQuantity },
            lastMovementAt: cancelledAt,
          },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            productId: item.productId,
            movementType: 'ADJUSTMENT_IN',
            movementDate: cancelledAt,
            baseQuantity: item.baseQuantity,
            ratePerBaseUnit: item.costPerBaseUnit,
            balanceAfter: stock.quantityOnHand,
            referenceType: 'SALES_INVOICE_CANCELLED',
            referenceId: invoice.id,
            referenceNumber: invoice.invoiceNumber,
            notes: `Cancellation of ${invoice.invoiceNumber}: ${reason}`,
            createdById: userId,
          },
        });
      }

      // ---- Reverse ledger with a contra entry, never by deleting the original ----
      const balance = await tx.partyBalance.update({
        where: { partyId: invoice.partyId },
        data: { currentBalance: { decrement: invoice.grandTotal }, lastEntryAt: cancelledAt },
      });

      await tx.ledgerEntry.create({
        data: {
          businessId,
          partyId: invoice.partyId,
          entryDate: cancelledAt,
          voucherType: 'ADJUSTMENT',
          voucherId: invoice.id,
          voucherNumber: invoice.invoiceNumber,
          debit: 0,
          credit: invoice.grandTotal,
          runningBalance: balance.currentBalance,
          narration: `Cancellation of invoice ${invoice.invoiceNumber}: ${reason}`,
        },
      });

      await tx.ewayBill.updateMany({
        where: { salesInvoiceId: invoice.id, status: { in: ['PENDING', 'PART_B_PENDING'] } },
        data: { status: 'CANCELLED', cancelledAt, cancelReason: reason },
      });

      await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: 'CANCELLED', cancelledAt, cancelledReason: reason },
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'sales_invoice.cancel',
          entityType: 'SalesInvoice',
          entityId: invoiceId,
          before: { status: invoice.status },
          after: { status: 'CANCELLED', reason },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
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

/// Dry run: full computation with warnings, nothing written. This is what the
/// voice confirmation card and the live invoice form both call.
export async function previewSalesInvoice(businessId: string, input: CreateSalesInvoiceInput) {
  const prepared = await prepareInvoice(businessId, input);
  return {
    supplyType: prepared.supplyType,
    party: {
      id: prepared.party.id,
      displayName: prepared.party.displayName,
      gstin: prepared.party.gstin,
      stateCode: prepared.party.stateCode,
    },
    lines: prepared.lines.map((l) => ({
      lineNumber: l.lineNumber,
      productId: l.productId,
      productName: l.productName,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      unitName: l.unitName,
      baseQuantity: l.baseQuantity,
      rate: l.rate,
      ...l.computed,
    })),
    totals: prepared.totals,
    amountInWords: amountInWords(prepared.totals.grandTotal),
    hsnSummary: buildHsnSummary(
      prepared.lines.map((l) => ({
        ...l.computed,
        hsnCode: l.hsnCode,
        uqc: l.uqc,
        quantity: l.quantity,
      })),
    ),
    ewayBillRequired: prepared.ewayBillRequired,
    warnings: prepared.warnings,
  };
}

export async function getSalesInvoice(businessId: string, invoiceId: string) {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, businessId },
    include: {
      items: { orderBy: { lineNumber: 'asc' } },
      party: { select: { id: true, displayName: true, phone: true, whatsappNumber: true } },
      ewayBill: true,
      allocations: { include: { payment: { select: { id: true, voucherNumber: true, paymentDate: true, mode: true } } } },
    },
  });
  if (!invoice) throw notFound('Invoice not found');

  return {
    ...invoice,
    amountDue: D(invoice.grandTotal).minus(D(invoice.amountPaid)),
    hsnSummary: buildHsnSummary(
      invoice.items.map((item) => ({
        hsnCode: item.hsnCode,
        uqc: item.uqc,
        quantity: D(item.quantity),
        grossAmount: D(item.taxableValue).plus(D(item.discountAmount)),
        discountAmount: D(item.discountAmount),
        discountPercent: D(item.discountPercent),
        taxableValue: D(item.taxableValue),
        cgstRate: D(item.cgstRate),
        cgstAmount: D(item.cgstAmount),
        sgstRate: D(item.sgstRate),
        sgstAmount: D(item.sgstAmount),
        igstRate: D(item.igstRate),
        igstAmount: D(item.igstAmount),
        cessRate: D(item.cessRate),
        cessAmount: D(item.cessAmount),
        lineTotal: D(item.lineTotal),
      })),
    ),
  };
}

export interface ListInvoicesFilter {
  partyId?: string;
  status?: InvoiceStatus;
  fromDate?: Date;
  toDate?: Date;
  /// Only invoices with money still outstanding.
  unpaidOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listSalesInvoices(businessId: string, filter: ListInvoicesFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.SalesInvoiceWhereInput = {
    businessId,
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.fromDate || filter.toDate
      ? {
          invoiceDate: {
            ...(filter.fromDate ? { gte: filter.fromDate } : {}),
            ...(filter.toDate ? { lte: filter.toDate } : {}),
          },
        }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { invoiceNumber: { contains: filter.search, mode: 'insensitive' } },
            { partyName: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {}),
    // Column-to-column comparison, so the filter runs in SQL. Filtering this in
    // memory after pagination would silently return short pages.
    ...(filter.unpaidOnly
      ? { grandTotal: { gt: prisma.salesInvoice.fields.amountPaid }, status: 'ISSUED' as const }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.salesInvoice.findMany({
      where,
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        status: true,
        partyId: true,
        partyName: true,
        supplyType: true,
        taxableValue: true,
        grandTotal: true,
        amountPaid: true,
        createdViaVoice: true,
      },
    }),
    prisma.salesInvoice.count({ where }),
  ]);

  const withDue = rows.map((row) => ({
    ...row,
    amountDue: D(row.grandTotal).minus(D(row.amountPaid)),
  }));

  return { invoices: withDue, total, page, pageSize };
}
