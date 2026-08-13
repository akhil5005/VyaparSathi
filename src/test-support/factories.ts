import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { currentFinancialYear } from '../lib/financialYear.js';
import { computeGstinChecksum } from '../lib/gstin.js';

let gstinSequence = 0;

/**
 * Builds a unique GSTIN with a genuinely correct mod-36 checksum.
 *
 * Unique because `Business.gstin` and party GSTINs are constrained, so a test
 * that creates two businesses would otherwise collide. Checksum-correct so the
 * same fixtures work whether the test inserts directly or goes through the
 * party service, which validates.
 */
export function makeGstin(stateCode = '03'): string {
  gstinSequence += 1;
  const digits = String(gstinSequence).padStart(4, '0');
  const first14 = `${stateCode}AAACT${digits}Q1Z`;
  return `${first14}${computeGstinChecksum(first14)}`;
}

/**
 * Fixture builders.
 *
 * Deliberately thin: each returns real rows created through Prisma, so the
 * tests exercise the same constraints production does. Anything a test cares
 * about is overridable; everything else gets a sane default so the test body
 * stays about the behaviour under examination.
 */

export interface TestContext {
  businessId: string;
  userId: string;
  unitIds: { ream: string; kg: string; packet: string };
  hsnCodeId: string;
}

/** A business, its owner, the unit master, and an HSN with a 12% rate. */
export async function createTestBusiness(
  overrides: { stateCode?: string; gstin?: string; hsnDigits?: number } = {},
): Promise<TestContext> {
  const business = await prisma.business.create({
    data: {
      legalName: 'Test Paper House',
      gstin: overrides.gstin ?? makeGstin(overrides.stateCode ?? '03'),
      stateCode: overrides.stateCode ?? '03',
      stateName: 'Punjab',
      addressLine1: 'Main Bazaar',
      city: 'Ludhiana',
      pincode: '141001',
      phone: '9876543210',
      hsnDigits: overrides.hsnDigits ?? 4,
    },
  });

  const user = await prisma.user.create({
    data: {
      businessId: business.id,
      fullName: 'Test Owner',
      phone: '9876543210',
      role: 'OWNER',
      passwordHash: await hashPassword('a-long-test-passphrase'),
    },
  });

  const [ream, kg, packet] = await Promise.all([
    prisma.unit.create({
      data: { businessId: business.id, name: 'Ream', symbol: 'rm', uqc: 'NOS' },
    }),
    prisma.unit.create({
      data: { businessId: business.id, name: 'Kilogram', symbol: 'kg', uqc: 'KGS' },
    }),
    prisma.unit.create({
      data: { businessId: business.id, name: 'Packet', symbol: 'pkt', uqc: 'PAC' },
    }),
  ]);

  const hsn = await prisma.hsnCode.create({
    data: {
      businessId: business.id,
      code: '4802',
      description: 'Uncoated writing and printing paper',
      taxRates: {
        create: {
          gstRate: 12,
          cessRate: 0,
          // Well before any test date so the as-at lookup always resolves.
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        },
      },
    },
  });

  // The sequences the invoice and purchase services allocate from.
  const financialYear = currentFinancialYear();
  await prisma.numberSequence.createMany({
    data: [
      { businessId: business.id, documentType: 'SALES_INVOICE', financialYear, prefix: 'INV/', padding: 4 },
      { businessId: business.id, documentType: 'PURCHASE_INVOICE', financialYear, prefix: 'PUR/', padding: 4 },
      { businessId: business.id, documentType: 'PAYMENT_RECEIPT', financialYear, prefix: 'RCP/', padding: 4 },
      { businessId: business.id, documentType: 'PAYMENT_VOUCHER', financialYear, prefix: 'PAY/', padding: 4 },
      { businessId: business.id, documentType: 'CREDIT_NOTE', financialYear, prefix: 'CN/', padding: 4 },
      { businessId: business.id, documentType: 'DEBIT_NOTE', financialYear, prefix: 'DN/', padding: 4 },
    ],
  });

  return {
    businessId: business.id,
    userId: user.id,
    unitIds: { ream: ream.id, kg: kg.id, packet: packet.id },
    hsnCodeId: hsn.id,
  };
}

export async function createTestParty(
  ctx: TestContext,
  overrides: {
    displayName?: string;
    stateCode?: string;
    gstin?: string | null;
    partyType?: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
    openingBalance?: number;
    creditLimit?: number;
  } = {},
) {
  const party = await prisma.party.create({
    data: {
      businessId: ctx.businessId,
      displayName: overrides.displayName ?? `Party ${Math.round(performance.now() * 1000)}`,
      partyType: overrides.partyType ?? 'CUSTOMER',
      gstin:
        overrides.gstin === null
          ? null
          : (overrides.gstin ?? makeGstin(overrides.stateCode ?? '03')),
      gstRegistrationType: overrides.gstin === null ? 'UNREGISTERED' : 'REGULAR',
      stateCode: overrides.stateCode ?? '03',
      stateName: overrides.stateCode === '06' ? 'Haryana' : 'Punjab',
      phone: '9811111111',
      openingBalance: overrides.openingBalance ?? 0,
      creditLimit: overrides.creditLimit ?? null,
    },
  });

  // Mirrors what the party service does — the ledger has to reconcile from its
  // first line, so the cache row exists from the start.
  await prisma.partyBalance.create({
    data: { partyId: party.id, currentBalance: overrides.openingBalance ?? 0 },
  });

  return party;
}

/**
 * A product with a ream base unit and a kg conversion, matching the real
 * A4 75gsm case: one ream weighs 2.3389 kg, so 1 kg = 0.4276 reams.
 */
export async function createTestProduct(
  ctx: TestContext,
  overrides: {
    name?: string;
    openingStock?: number;
    openingCost?: number;
    defaultSaleRate?: number;
    reorderLevel?: number;
  } = {},
) {
  const product = await prisma.product.create({
    data: {
      businessId: ctx.businessId,
      name: overrides.name ?? `Product ${Math.round(performance.now() * 1000)}`,
      hsnCodeId: ctx.hsnCodeId,
      baseUnitId: ctx.unitIds.ream,
      defaultSaleUnitId: ctx.unitIds.ream,
      defaultPurchaseUnitId: ctx.unitIds.kg,
      gsm: 75,
      sheetSize: 'A4',
      sheetsPerReam: 500,
      weightPerBaseUnitKg: '2.3389',
      defaultSaleRate: overrides.defaultSaleRate ?? 240,
      reorderLevel: overrides.reorderLevel ?? null,
      productUnits: {
        create: [
          { unitId: ctx.unitIds.ream, conversionToBase: 1, isSalesDefault: true },
          { unitId: ctx.unitIds.kg, conversionToBase: '0.4276', isPurchaseDefault: true },
          { unitId: ctx.unitIds.packet, conversionToBase: 5 },
        ],
      },
      stock: {
        create: {
          businessId: ctx.businessId,
          quantityOnHand: overrides.openingStock ?? 100,
          avgCostPerBaseUnit: overrides.openingCost ?? 200,
        },
      },
    },
    include: { stock: true, productUnits: true },
  });

  return product;
}

/// Convenience: everything a billing test needs, in one call.
export async function setupBillingScenario() {
  const ctx = await createTestBusiness();
  const customer = await createTestParty(ctx, { displayName: 'Sharma Stationery' });
  const supplier = await createTestParty(ctx, {
    displayName: 'JK Paper Mills',
    partyType: 'SUPPLIER',
  });
  const product = await createTestProduct(ctx, { name: 'JK Copier A4 75gsm' });
  return { ctx, customer, supplier, product };
}
