/**
 * A starter product catalogue for a Punjab paper merchant.
 *
 *   npm run db:seed            # HSN codes and rates — run this first
 *   npm run db:seed:catalogue  # this file
 *
 * **These are plausible products at plausible rates, not real ones.** They exist
 * so the billing, stock and purchase screens have something to work against
 * during development and demos. Before the shop goes live, either correct every
 * rate against the actual price list or delete the lot and enter the real range
 * — a wrong rate here is a wrong invoice.
 *
 * Idempotent: a product whose name already exists is skipped, so re-running is
 * safe and never duplicates or overwrites.
 *
 * Products go in through `createProduct`, not straight into the table, so they
 * pick up the same derivations a hand-entered product gets — most importantly
 * the reams↔kg conversion, which is what lets a ream-priced product be bought
 * from the mill by weight.
 */
import { PrismaClient } from '@prisma/client';
import { createProduct } from '../src/modules/masters/product.service.js';

const prisma = new PrismaClient();

interface SeedProduct {
  name: string;
  brand?: string;
  /// HSN code, which must already exist — run `npm run db:seed` first.
  hsn: string;
  /// Unit name as created at registration: Ream, Kilogram, Packet, Piece, Bundle.
  unit: string;
  gsm?: number;
  /**
   * Bare numbers are **inches** — the Indian paper trade's convention. 23x36,
   * 20x30 and 25x36 are all inch sizes, and reading them as millimetres would
   * make a ream weigh a few grams.
   */
  sheetSize?: string;
  sheetsPerReam?: number;
  saleRate: string;
  /// Roughly 80% of the sale rate, which is a normal paper-trade margin.
  costRate: string;
  openingStock: string;
  reorderLevel: string;
}

const CATALOGUE: SeedProduct[] = [
  // ---- 4802: copier and writing paper, the bread and butter ----
  {
    name: 'JK Copier A4 75gsm',
    brand: 'JK Paper',
    hsn: '4802',
    unit: 'Ream',
    gsm: 75,
    sheetSize: 'A4',
    sheetsPerReam: 500,
    saleRate: '240',
    costRate: '196',
    openingStock: '120',
    reorderLevel: '25',
  },
  {
    name: 'JK Copier A3 75gsm',
    brand: 'JK Paper',
    hsn: '4802',
    unit: 'Ream',
    gsm: 75,
    sheetSize: 'A3',
    sheetsPerReam: 500,
    saleRate: '478',
    costRate: '392',
    openingStock: '30',
    reorderLevel: '8',
  },
  {
    name: 'JK Easy Copier A4 70gsm',
    brand: 'JK Paper',
    hsn: '4802',
    unit: 'Ream',
    gsm: 70,
    sheetSize: 'A4',
    sheetsPerReam: 500,
    saleRate: '214',
    costRate: '176',
    openingStock: '80',
    reorderLevel: '20',
  },
  {
    name: 'Trident Spectra A4 75gsm',
    brand: 'Trident',
    hsn: '4802',
    unit: 'Ream',
    gsm: 75,
    sheetSize: 'A4',
    sheetsPerReam: 500,
    saleRate: '232',
    costRate: '190',
    openingStock: '60',
    reorderLevel: '15',
  },
  {
    // A full-size mill sheet: one ream of this weighs about 18.7 kg, which is
    // why it is bought by weight and sold by the ream.
    name: 'Century Maplitho 70gsm 23x36',
    brand: 'Century',
    hsn: '4802',
    unit: 'Ream',
    gsm: 70,
    sheetSize: '23x36',
    sheetsPerReam: 500,
    saleRate: '1150',
    costRate: '940',
    openingStock: '18',
    reorderLevel: '5',
  },

  // ---- 4801: newsprint, traded by weight ----
  {
    name: 'Newsprint 45gsm',
    hsn: '4801',
    unit: 'Kilogram',
    saleRate: '58',
    costRate: '47',
    openingStock: '400',
    reorderLevel: '100',
  },

  // ---- 4810: coated ----
  {
    name: 'Art Paper 130gsm 20x30',
    hsn: '4810',
    unit: 'Ream',
    gsm: 130,
    sheetSize: '20x30',
    sheetsPerReam: 500,
    saleRate: '1450',
    costRate: '1190',
    openingStock: '12',
    reorderLevel: '4',
  },
  {
    name: 'Chromo Sticker Paper 20x30',
    hsn: '4810',
    unit: 'Ream',
    gsm: 90,
    sheetSize: '20x30',
    sheetsPerReam: 500,
    saleRate: '1850',
    costRate: '1520',
    openingStock: '8',
    reorderLevel: '3',
  },

  // ---- 4805: other uncoated, boards and kraft ----
  {
    name: 'Kraft Paper 120gsm',
    hsn: '4805',
    unit: 'Kilogram',
    saleRate: '52',
    costRate: '42',
    openingStock: '350',
    reorderLevel: '80',
  },
  {
    name: 'Duplex Board 250gsm 20x30',
    hsn: '4805',
    unit: 'Ream',
    gsm: 250,
    sheetSize: '20x30',
    sheetsPerReam: 250,
    saleRate: '2100',
    costRate: '1720',
    openingStock: '10',
    reorderLevel: '3',
  },

  // ---- 4817: envelopes ----
  {
    name: 'Envelope 9x4 White',
    hsn: '4817',
    unit: 'Packet',
    saleRate: '95',
    costRate: '76',
    openingStock: '150',
    reorderLevel: '40',
  },
  {
    name: 'Envelope 10x12 Brown',
    hsn: '4817',
    unit: 'Packet',
    saleRate: '180',
    costRate: '146',
    openingStock: '90',
    reorderLevel: '25',
  },

  // ---- 4820: registers and notebooks ----
  {
    name: 'Register 3 Quire',
    hsn: '4820',
    unit: 'Piece',
    saleRate: '165',
    costRate: '132',
    openingStock: '70',
    reorderLevel: '20',
  },
  {
    name: 'Notebook 172 Pages',
    hsn: '4820',
    unit: 'Bundle',
    saleRate: '540',
    costRate: '432',
    openingStock: '45',
    reorderLevel: '12',
  },
  {
    name: 'Letter Pad A5',
    hsn: '4820',
    unit: 'Piece',
    saleRate: '45',
    costRate: '35',
    openingStock: '200',
    reorderLevel: '50',
  },

  // ---- 4823: cut to size ----
  {
    name: 'Tissue Roll 2 Ply',
    hsn: '4823',
    unit: 'Packet',
    saleRate: '120',
    costRate: '95',
    openingStock: '60',
    reorderLevel: '15',
  },
];

async function main() {
  const business = await prisma.business.findFirst({
    select: { id: true, legalName: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!business) {
    console.log('No business registered yet. Sign up in the app first.');
    return;
  }

  // Products are attributed to a real user for the audit trail; the owner is
  // the honest choice for data that was loaded rather than typed.
  const owner = await prisma.user.findFirst({
    where: { businessId: business.id, role: 'OWNER' },
    select: { id: true },
  });
  if (!owner) {
    console.log('No owner account found for that business.');
    return;
  }

  const [hsnCodes, units] = await Promise.all([
    prisma.hsnCode.findMany({ where: { businessId: business.id } }),
    prisma.unit.findMany({ where: { businessId: business.id } }),
  ]);

  const hsnByCode = new Map(hsnCodes.map((h) => [h.code, h.id]));
  const unitByName = new Map(units.map((u) => [u.name, u.id]));

  if (hsnByCode.size === 0) {
    console.log('No HSN codes found. Run `npm run db:seed` first.');
    return;
  }

  const existing = new Set(
    (
      await prisma.product.findMany({
        where: { businessId: business.id },
        select: { name: true },
      })
    ).map((p) => p.name),
  );

  let created = 0;
  let skipped = 0;

  for (const item of CATALOGUE) {
    if (existing.has(item.name)) {
      skipped++;
      continue;
    }

    const hsnCodeId = hsnByCode.get(item.hsn);
    const baseUnitId = unitByName.get(item.unit);

    if (!hsnCodeId || !baseUnitId) {
      console.log(
        `  skipped "${item.name}" — ${!hsnCodeId ? `HSN ${item.hsn}` : `unit ${item.unit}`} not set up`,
      );
      skipped++;
      continue;
    }

    await createProduct(
      business.id,
      owner.id,
      {
        name: item.name,
        ...(item.brand ? { brand: item.brand } : {}),
        hsnCodeId,
        baseUnitId,
        ...(item.gsm ? { gsm: item.gsm } : {}),
        ...(item.sheetSize ? { sheetSize: item.sheetSize } : {}),
        ...(item.sheetsPerReam ? { sheetsPerReam: item.sheetsPerReam } : {}),
        defaultSaleRate: item.saleRate,
        defaultPurchaseRate: item.costRate,
        reorderLevel: item.reorderLevel,
        openingStock: item.openingStock,
        openingStockRate: item.costRate,
      },
      { ipAddress: '127.0.0.1', userAgent: 'seed-catalogue' },
    );

    created++;
    console.log(`  + ${item.name}`);
  }

  console.log(
    `\nDone for "${business.legalName}": ${created} created, ${skipped} already there.\n` +
      `\n  These rates are illustrative. Correct them against the real price list\n` +
      `  before issuing an invoice to a customer.\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
