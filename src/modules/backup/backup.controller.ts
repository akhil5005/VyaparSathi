import { handler, scopeOf } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { backupSummary, exportBusiness } from './backup.service.js';

/// What the file will contain, so nobody downloads an empty backup unknowingly.
export const summary = handler(async (req, res) => {
  res.json(await backupSummary(scopeOf(req).businessId));
});

/**
 * The whole shop, as a download.
 *
 * Named with the date so a folder of these sorts chronologically and the one
 * from before a mistake can be found. `no-store` because a proxy holding a copy
 * of somebody's entire ledger is exactly the thing this file must not do.
 */
export const download = handler(async (req, res) => {
  const { businessId } = scopeOf(req);
  const backup = await exportBusiness(businessId);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { gstin: true },
  });
  const date = backup.exportedAt.slice(0, 10);

  res
    .status(200)
    .set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="vyapar-sathi-backup-${business?.gstin ?? 'shop'}-${date}.json"`,
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify(backup, null, 2));
});
