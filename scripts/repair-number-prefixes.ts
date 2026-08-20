/**
 * Gives a document series its prefix back.
 *
 *   DATABASE_URL="postgresql://…" npm run repair:number-prefixes
 *   DATABASE_URL="postgresql://…" npm run repair:number-prefixes -- --apply
 *
 * Registration used to seed number series for five document types and miss
 * `PURCHASE_INVOICE` and `PAYMENT_VOUCHER`. Both holes are closed for new
 * shops, but neither fix can reach a series that already exists — the seed
 * runs once at registration, and the default prefix only applies when a series
 * is created. A shop that entered its first supplier bill before the fix has a
 * series numbering `0001`, `0002` … and will keep doing so.
 *
 * Prints what it would do and changes nothing unless `--apply` is given. The
 * logic lives in `src/modules/invoices/numbering.ts`, where it is tested;
 * this file is only the command around it.
 */
import { PrismaClient } from '@prisma/client';
import { repairMissingPrefixes } from '../src/modules/invoices/numbering.js';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const repairs = await repairMissingPrefixes(prisma, { apply });

  if (repairs.length === 0) {
    console.log('\n✔ Every document series has a prefix. Nothing to repair.\n');
    return;
  }

  const shops = new Map(
    (
      await prisma.business.findMany({
        where: { id: { in: [...new Set(repairs.map((r) => r.businessId))] } },
        select: { id: true, tradeName: true, legalName: true },
      })
    ).map((b) => [b.id, b.tradeName ?? b.legalName]),
  );

  console.log(`\n${repairs.length} series ${apply ? 'repaired' : 'would be repaired'}:\n`);

  for (const repair of repairs) {
    console.log(`  ${shops.get(repair.businessId) ?? repair.businessId} · ${repair.documentType} · ${repair.financialYear}`);
    console.log(`    prefix ""  →  "${repair.prefix}"`);
    if (repair.alreadyIssued > 0) {
      console.log(
        `    ⚠ ${repair.alreadyIssued} document${repair.alreadyIssued === 1 ? '' : 's'} ` +
          'already issued without it. Those keep the numbers they were given — ' +
          'a number that has gone out is never rewritten. Cancel and re-enter ' +
          'them if the numbering matters more than the history.',
      );
    }
    console.log('');
  }

  console.log(
    apply ? '✔ Done.\n' : 'Nothing was changed. Re-run with --apply to write these.\n',
  );
}

main()
  .catch((error) => {
    console.error('\n✖ Repair failed:', error instanceof Error ? error.message : error, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
