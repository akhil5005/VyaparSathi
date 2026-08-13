import { handler, scopeOf } from '../../lib/http.js';
import { buildGstr1 } from './gstr1.service.js';
import { gstr1QuerySchema } from './gstr1.schemas.js';

/**
 * The summary, for checking on screen before anything is downloaded.
 *
 * Returned separately from the JSON because the JSON is unreadable by design —
 * nobody can eyeball a portal payload for a missing invoice.
 */
export const summary = handler(async (req, res) => {
  const { period } = gstr1QuerySchema.parse(req.query);
  const { summary } = await buildGstr1(scopeOf(req).businessId, period);
  res.json({ summary });
});

/**
 * The portal payload, as a download.
 *
 * Pretty-printed rather than minified: this file gets opened in a text editor
 * by a CA at some point, and two kilobytes saved is worth nothing against that.
 */
export const download = handler(async (req, res) => {
  const { period } = gstr1QuerySchema.parse(req.query);
  const scope = scopeOf(req);
  const { json } = await buildGstr1(scope.businessId, period);

  res
    .status(200)
    .set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="GSTR1_${json.gstin}_${json.fp}.json"`,
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify(json, null, 2));
});
