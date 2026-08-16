import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { D, ZERO } from '../../lib/money.js';
import { STATE_CODES, validateGstin } from '../../lib/gstin.js';
import type { RequestContext } from '../auth/auth.service.js';
import type {
  createPartySchema,
  listPartiesQuerySchema,
  setPartyRateSchema,
  updatePartySchema,
} from './masters.schemas.js';

type CreatePartyInput = z.infer<typeof createPartySchema>;
type UpdatePartyInput = z.infer<typeof updatePartySchema>;
type ListPartiesFilter = z.infer<typeof listPartiesQuerySchema>;
type SetPartyRateInput = z.infer<typeof setPartyRateSchema>;

/**
 * The place of supply drives the whole tax split, so it is derived from the
 * GSTIN whenever there is one and only accepted manually for unregistered
 * customers. A GSTIN whose state code contradicts a supplied state code is a
 * data-entry error worth catching here rather than on a filed return.
 */
function resolveStatePlacement(input: { gstin?: string; stateCode?: string }) {
  if (input.gstin) {
    const check = validateGstin(input.gstin);
    if (!check.valid) throw badRequest(check.reason ?? 'Invalid GSTIN');
    if (input.stateCode && input.stateCode !== check.stateCode) {
      throw badRequest(
        `GSTIN belongs to ${check.stateName} (${check.stateCode}) but state code ${input.stateCode} was given`,
      );
    }
    return { stateCode: check.stateCode!, stateName: check.stateName!, pan: check.pan ?? null };
  }

  if (!input.stateCode) {
    throw badRequest('A state code is required when there is no GSTIN');
  }
  return {
    stateCode: input.stateCode,
    stateName: STATE_CODES[input.stateCode] ?? null,
    pan: null,
  };
}

export async function createParty(
  businessId: string,
  userId: string,
  input: CreatePartyInput,
  ctx: RequestContext,
) {
  const placement = resolveStatePlacement(input);

  const existing = await prisma.party.findFirst({
    where: { businessId, displayName: input.displayName },
    select: { id: true },
  });
  if (existing) throw conflict(`A party named "${input.displayName}" already exists`);

  if (input.gstin) {
    const gstinClash = await prisma.party.findFirst({
      where: { businessId, gstin: input.gstin },
      select: { id: true, displayName: true },
    });
    if (gstinClash) {
      throw conflict(`That GSTIN is already on "${gstinClash.displayName}"`);
    }
  }

  const openingBalance = D(input.openingBalance ?? 0);

  const party = await prisma.$transaction(async (tx) => {
    const created = await tx.party.create({
      data: {
        businessId,
        displayName: input.displayName,
        legalName: input.legalName ?? null,
        partyType: input.partyType ?? 'CUSTOMER',
        gstin: input.gstin ?? null,
        // A party with a GSTIN is a registered dealer unless told otherwise.
        gstRegistrationType:
          input.gstRegistrationType ?? (input.gstin ? 'REGULAR' : 'UNREGISTERED'),
        pan: placement.pan,
        stateCode: placement.stateCode,
        stateName: placement.stateName,
        phone: input.phone ?? null,
        alternatePhone: input.alternatePhone ?? null,
        whatsappNumber: input.whatsappNumber ?? input.phone ?? null,
        email: input.email ?? null,
        contactPerson: input.contactPerson ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        pincode: input.pincode ?? null,
        openingBalance,
        openingBalanceDate: input.openingBalanceDate ?? (openingBalance.isZero() ? null : new Date()),
        creditLimit: input.creditLimit ?? null,
        creditDays: input.creditDays ?? null,
        notes: input.notes ?? null,
      },
    });

    // Seed the cached balance and write the opening entry, so the ledger
    // reconciles from the very first line instead of starting mid-story.
    await tx.partyBalance.create({
      data: {
        partyId: created.id,
        currentBalance: openingBalance,
        lastEntryAt: openingBalance.isZero() ? null : created.openingBalanceDate,
      },
    });

    if (!openingBalance.isZero()) {
      await tx.ledgerEntry.create({
        data: {
          businessId,
          partyId: created.id,
          entryDate: created.openingBalanceDate ?? new Date(),
          voucherType: 'OPENING_BALANCE',
          debit: openingBalance.greaterThan(0) ? openingBalance : 0,
          credit: openingBalance.lessThan(0) ? openingBalance.abs() : 0,
          runningBalance: openingBalance,
          narration: 'Opening balance carried forward',
        },
      });
    }

    await tx.auditLog.create({
      data: {
        businessId,
        userId,
        action: 'party.create',
        entityType: 'Party',
        entityId: created.id,
        after: { displayName: created.displayName, gstin: created.gstin, stateCode: created.stateCode },
        ipAddress: ctx.ipAddress ?? null,
      },
    });

    return created;
  });

  return party;
}

export async function updateParty(
  businessId: string,
  userId: string,
  partyId: string,
  patch: UpdatePartyInput,
  ctx: RequestContext,
) {
  const party = await prisma.party.findFirst({ where: { id: partyId, businessId } });
  if (!party) throw notFound('Party not found');

  // Re-derive placement only when the GSTIN or state code is actually changing.
  let placement: { stateCode: string; stateName: string | null; pan: string | null } | null = null;
  if (patch.gstin !== undefined || patch.stateCode !== undefined) {
    // `gstin: null` means "they are no longer registered", which is not the
    // same as leaving it out. In that case the state can no longer be derived
    // from the number, so it has to come from the patch or from what is
    // already on the party.
    const clearingGstin = patch.gstin === null;
    placement = resolveStatePlacement({
      ...(clearingGstin ? {} : { gstin: patch.gstin ?? party.gstin ?? undefined }),
      // A state code given *alongside* a GSTIN is passed through rather than
      // dropped, so a contradiction between the two is rejected here exactly as
      // it is on create. Silently preferring the GSTIN would reach the right
      // answer while hiding the fact that the caller believed something else.
      ...(patch.stateCode !== undefined
        ? { stateCode: patch.stateCode }
        : clearingGstin || !patch.gstin
          ? { stateCode: party.stateCode }
          : {}),
    });
  }

  if (patch.displayName && patch.displayName !== party.displayName) {
    const clash = await prisma.party.findFirst({
      where: { businessId, displayName: patch.displayName, id: { not: partyId } },
      select: { id: true },
    });
    if (clash) throw conflict(`A party named "${patch.displayName}" already exists`);
  }

  const { stateCode: _sc, gstin: _g, ...rest } = patch;

  const updated = await prisma.party.update({
    where: { id: partyId },
    data: {
      ...rest,
      ...(patch.gstin !== undefined
        ? {
            gstin: patch.gstin,
            ...(patch.gstin === null ? { gstRegistrationType: 'UNREGISTERED' as const } : {}),
          }
        : {}),
      ...(placement
        ? { stateCode: placement.stateCode, stateName: placement.stateName, pan: placement.pan }
        : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId,
      action: 'party.update',
      entityType: 'Party',
      entityId: partyId,
      before: { displayName: party.displayName, gstin: party.gstin, stateCode: party.stateCode, isActive: party.isActive },
      after: { displayName: updated.displayName, gstin: updated.gstin, stateCode: updated.stateCode, isActive: updated.isActive },
      ipAddress: ctx.ipAddress ?? null,
    },
  });

  return updated;
}

export async function listParties(businessId: string, filter: ListPartiesFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.PartyWhereInput = {
    businessId,
    ...(filter.partyType ? { partyType: { in: [filter.partyType, 'BOTH'] } } : {}),
    ...(filter.isActive !== undefined ? { isActive: filter.isActive } : {}),
    ...(filter.search
      ? {
          OR: [
            { displayName: { contains: filter.search, mode: 'insensitive' } },
            { legalName: { contains: filter.search, mode: 'insensitive' } },
            { phone: { contains: filter.search } },
            { gstin: { contains: filter.search.toUpperCase() } },
          ],
        }
      : {}),
    ...(filter.withBalanceOnly ? { balance: { currentBalance: { not: 0 } } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.party.findMany({
      where,
      include: { balance: { select: { currentBalance: true, lastEntryAt: true } } },
      orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.party.count({ where }),
  ]);

  return {
    parties: rows.map((p) => ({
      ...p,
      currentBalance: D(p.balance?.currentBalance ?? 0),
      overCreditLimit:
        p.creditLimit !== null && D(p.balance?.currentBalance ?? 0).greaterThan(D(p.creditLimit)),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getParty(businessId: string, partyId: string) {
  const party = await prisma.party.findFirst({
    where: { id: partyId, businessId },
    include: {
      balance: true,
      partyRates: {
        include: { product: { select: { id: true, name: true } }, unit: { select: { id: true, name: true, symbol: true } } },
        orderBy: { effectiveFrom: 'desc' },
      },
    },
  });
  if (!party) throw notFound('Party not found');

  /**
   * Both sides of the relationship, because in this trade one firm is often
   * both. A mill you buy reels from also buys back your cut waste; showing
   * only `totalBilled` made a pure supplier read "₹0.00, 0 invoices" while
   * lakhs moved through the account.
   */
  const [invoiceStats, purchaseStats, oldestUnpaid] = await Promise.all([
    prisma.salesInvoice.aggregate({
      where: { businessId, partyId, status: 'ISSUED' },
      _count: true,
      _sum: { grandTotal: true },
    }),
    prisma.purchaseInvoice.aggregate({
      where: { businessId, partyId, status: 'ISSUED' },
      _count: true,
      _sum: { grandTotal: true },
    }),
    prisma.salesInvoice.findFirst({
      where: {
        businessId,
        partyId,
        status: 'ISSUED',
        grandTotal: { gt: prisma.salesInvoice.fields.amountPaid },
      },
      orderBy: { invoiceDate: 'asc' },
      select: { id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true, amountPaid: true },
    }),
  ]);

  return {
    ...party,
    currentBalance: D(party.balance?.currentBalance ?? 0),
    stats: {
      invoiceCount: invoiceStats._count,
      totalBilled: D(invoiceStats._sum.grandTotal ?? 0),
      purchaseCount: purchaseStats._count,
      totalPurchased: D(purchaseStats._sum.grandTotal ?? 0),
      oldestUnpaidInvoice: oldestUnpaid,
    },
  };
}

/**
 * One party's account — every document that moved their balance, either way.
 *
 * There is one ledger per *party*, not per role. The same firm can sell you
 * reels in the morning and buy back cut waste in the afternoon, and the whole
 * point of a bahi khata is that both land on one page and net off. Sales and
 * debit notes debit the account, purchases and credit notes credit it, receipts
 * credit and payments debit — so the sign convention holds whichever direction
 * the trade runs, and `runningBalance` reads Dr when they owe you and Cr when
 * you owe them.
 */
export async function getPartyLedger(
  businessId: string,
  partyId: string,
  options: {
    fromDate?: Date;
    toDate?: Date;
    page?: number;
    pageSize?: number;
    /// 'asc' reads like a printed ledger; 'desc' puts the latest first, which
    /// is what the party dialog wants.
    order?: 'asc' | 'desc';
  } = {},
) {
  const party = await prisma.party.findFirst({
    where: { id: partyId, businessId },
    select: { id: true, displayName: true, partyType: true, openingBalance: true },
  });
  if (!party) throw notFound('Party not found');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, options.pageSize ?? 100));
  const order = options.order ?? 'desc';

  const where: Prisma.LedgerEntryWhereInput = {
    businessId,
    partyId,
    ...(options.fromDate || options.toDate
      ? {
          entryDate: {
            ...(options.fromDate ? { gte: options.fromDate } : {}),
            ...(options.toDate ? { lte: options.toDate } : {}),
          },
        }
      : {}),
  };

  const [entries, total, totals, brought] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      /**
       * Newest first, by **insertion** order rather than entry date.
       *
       * `runningBalance` is computed and stored when the row is written, so it
       * is only coherent read back in that same sequence. Ordering by
       * `entryDate` looks more like a ledger and quietly breaks the column: an
       * invoice carries a time, a payment entered from a date input is
       * midnight, so on a day with both the payment sorts ahead of the sale
       * that caused it and the balances read 0 → 2,832 → 1,832 → 1,032. An
       * account that appears not to add up.
       *
       * The parties screen used to re-sort each page to work around this,
       * which fixed the view within a page and could not fix it across pages —
       * so once the ledger paginated, the workaround had to become the rule.
       * Each row's balance now genuinely follows from the row below it.
       *
       * Filtering still uses `entryDate`, because "March's entries" means the
       * dates on the documents, not when they were typed in.
       */
      orderBy: [{ createdAt: order }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ledgerEntry.count({ where }),
    prisma.ledgerEntry.aggregate({ where, _sum: { debit: true, credit: true } }),
    /**
     * What the account stood at the moment the period began.
     *
     * Without this a date-filtered ledger is a lie: the closing balance used to
     * be computed as the period's own debits minus its credits, so asking for
     * "this financial year" on an account carrying ₹50,000 forward from last
     * year reported a closing balance that ignored the ₹50,000 entirely. A
     * statement has to start from where the last one ended.
     */
    options.fromDate
      ? prisma.ledgerEntry.aggregate({
          where: { businessId, partyId, entryDate: { lt: options.fromDate } },
          _sum: { debit: true, credit: true },
        })
      : null,
  ]);

  const periodDebit = D(totals._sum.debit ?? 0);
  const periodCredit = D(totals._sum.credit ?? 0);
  const openingBalance = brought
    ? D(brought._sum.debit ?? 0).minus(D(brought._sum.credit ?? 0))
    : ZERO();

  return {
    party,
    entries,
    total,
    page,
    pageSize,
    order,
    /// Balance carried into the period. Zero when no `fromDate` was given,
    /// because then the period is the whole account and its own first entry is
    /// the opening one.
    openingBalance,
    totalDebit: periodDebit,
    totalCredit: periodCredit,
    closingBalance: openingBalance.plus(periodDebit).minus(periodCredit),
  };
}

/**
 * Sets a customer-specific rate for a product.
 *
 * Rates are versioned, not overwritten: setting a new one closes the open row
 * the instant before, so an old invoice can still be explained.
 */
export async function setPartyRate(businessId: string, partyId: string, input: SetPartyRateInput) {
  const [party, product, unit] = await Promise.all([
    prisma.party.findFirst({ where: { id: partyId, businessId }, select: { id: true } }),
    prisma.product.findFirst({ where: { id: input.productId, businessId }, select: { id: true } }),
    prisma.unit.findFirst({ where: { id: input.unitId, businessId }, select: { id: true } }),
  ]);
  if (!party) throw notFound('Party not found');
  if (!product) throw notFound('Product not found');
  if (!unit) throw notFound('Unit not found');

  const effectiveFrom = input.effectiveFrom ?? new Date();

  return prisma.$transaction(async (tx) => {
    const open = await tx.partyRate.findFirst({
      where: { partyId, productId: input.productId, unitId: input.unitId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (open) {
      if (open.effectiveFrom >= effectiveFrom) {
        throw badRequest('The new rate must start after the current one');
      }
      await tx.partyRate.update({
        where: { id: open.id },
        data: { effectiveTo: new Date(effectiveFrom.getTime() - 1) },
      });
    }

    return tx.partyRate.create({
      data: {
        partyId,
        productId: input.productId,
        unitId: input.unitId,
        rate: input.rate,
        effectiveFrom,
      },
    });
  });
}

export async function deletePartyRate(businessId: string, partyId: string, rateId: string) {
  const rate = await prisma.partyRate.findFirst({
    where: { id: rateId, partyId, party: { businessId } },
  });
  if (!rate) throw notFound('Rate not found');
  await prisma.partyRate.delete({ where: { id: rateId } });
  return { deleted: true };
}
