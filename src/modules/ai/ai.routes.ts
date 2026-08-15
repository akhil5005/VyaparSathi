import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_EDIT_MASTERS } from '../../middleware/authorize.js';
import { handler, scopeOf } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { extractor } from '../../lib/anthropic.js';
import { scanPurchaseBill } from './scanPurchase.service.js';

export const aiRouter = Router();

/**
 * Images do not fit the global 2 MB JSON cap.
 *
 * A phone camera produces 3–6 MB per frame. The web app downscales before
 * uploading, which is the real fix — a bill is legible at 1600px and costs a
 * fraction of the tokens — but the cap here has to allow a couple of pages of
 * that, plus base64's 33% overhead, without raising the limit for every other
 * endpoint in the app.
 */
aiRouter.use('/scan-purchase', express.json({ limit: '12mb' }));

aiRouter.use(authenticate);

const imageSchema = z.object({
  /// Base64 without the data: prefix; the browser strips it before sending.
  data: z.string().min(100, 'That image is empty').max(9_000_000, 'That image is too large'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const scanSchema = z.object({
  // More than four pages is not a shop invoice, it is a mistake.
  images: z.array(imageSchema).min(1, 'Attach a photo of the bill').max(4),
});

/**
 * Reading a supplier bill. Owner and manager only — it is the purchase form's
 * front door, and entering purchases is already gated the same way.
 */
aiRouter.post(
  '/scan-purchase',
  authorize(...CAN_EDIT_MASTERS),
  handler(async (req, res) => {
    const input = scanSchema.parse(req.body);
    res.json({ bill: await scanPurchaseBill(scopeOf(req).businessId, input.images) });
  }),
);

/**
 * Whether the AI features are switched on at all.
 *
 * A property of the deployment, not of any user, so it says so plainly instead
 * of letting a screen offer a button that will always fail. Same reasoning as
 * the password-reset delivery flag.
 */
aiRouter.get(
  '/status',
  handler(async (_req, res) => {
    res.json({ available: extractor.available });
  }),
);

aiRouter.use(
  handler(async () => {
    throw badRequest('Unknown AI endpoint');
  }),
);
