/**
 * Seeds the HSN master for every registered business.
 *
 * Idempotent — safe to re-run. Run after `npm run prisma:migrate` and after
 * registering the business through `POST /api/auth/register`.
 *
 * Rates are 18%, confirmed for every product this business sells. They still
 * live in HsnTaxRate with an effective-from date rather than as a column on
 * Product, because the GST Council revises slabs and an invoice issued last year
 * must keep printing last year's rate. When a rate changes, add a new row with
 * the new effectiveFrom — never edit an existing one.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/// Chapter 48 — paper and paperboard.
const PAPER_HSN = [
  { code: '4802', description: 'Uncoated paper for writing/printing (A4, copier, printing paper)' },
  { code: '4801', description: 'Newsprint, in rolls or sheets' },
  { code: '4805', description: 'Other uncoated paper and paperboard' },
  { code: '4810', description: 'Coated paper and paperboard (art paper, chromo)' },
  { code: '4817', description: 'Envelopes, letter cards, plain postcards' },
  { code: '4820', description: 'Registers, notebooks, letter pads, files' },
  { code: '4823', description: 'Other paper cut to size (tissue, wrapping)' },
];

/**
 * 18% on everything sold here — confirmed, not assumed.
 *
 * Intra-state this splits 9% CGST + 9% SGST; inter-state it is 18% IGST. The
 * split is derived at billing time from the GSTIN state codes, so only the
 * combined rate is stored.
 */
const GST_RATE = 18.0;

/**
 * Backdated to the start of the current financial year so the as-at lookup
 * resolves for any invoice dated in this FY, including one entered late for a
 * sale that happened in April.
 */
const EFFECTIVE_FROM = (() => {
  const now = new Date();
  // Financial years run April–March, so before April we are still in the FY
  // that opened last April.
  const year = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(`${year}-04-01T00:00:00.000Z`);
})();

async function main() {
  const businesses = await prisma.business.findMany({ select: { id: true, legalName: true } });

  if (businesses.length === 0) {
    console.log('No businesses found. Register one via POST /api/auth/register first.');
    return;
  }

  for (const business of businesses) {
    for (const hsn of PAPER_HSN) {
      const record = await prisma.hsnCode.upsert({
        where: { businessId_code: { businessId: business.id, code: hsn.code } },
        create: { businessId: business.id, code: hsn.code, description: hsn.description },
        update: { description: hsn.description },
      });

      await prisma.hsnTaxRate.upsert({
        where: {
          hsnCodeId_effectiveFrom: { hsnCodeId: record.id, effectiveFrom: EFFECTIVE_FROM },
        },
        create: {
          hsnCodeId: record.id,
          gstRate: GST_RATE,
          cessRate: 0,
          effectiveFrom: EFFECTIVE_FROM,
          notes: 'Confirmed 18% across all products.',
        },
        // Re-running must correct a rate left over from an earlier seed rather
        // than silently keeping it.
        update: { gstRate: GST_RATE, cessRate: 0 },
      });
    }
    console.log(`Seeded ${PAPER_HSN.length} HSN codes for "${business.legalName}"`);
  }

  console.log(
    `\nGST seeded at ${GST_RATE}% effective ${EFFECTIVE_FROM.toISOString().slice(0, 10)} ` +
      `(9% CGST + 9% SGST within Punjab, 18% IGST outside).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
