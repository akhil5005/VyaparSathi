import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_EDIT_MASTERS, CAN_SEE_COST, CAN_VIEW } from '../../middleware/authorize.js';
import { handler, scopeOf } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { extractor } from '../../lib/anthropic.js';
import { scanPurchaseBill } from './scanPurchase.service.js';
import { transcriber } from '../voice/asr.js';
import { askVoiceQuestion } from '../voice/voiceQuery.service.js';

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

/**
 * Audio is smaller than a photograph but still above the global cap.
 *
 * A few seconds of Opus is tens of kilobytes; the headroom is for a browser
 * that recorded uncompressed and for base64's third.
 */
aiRouter.use('/ask', express.json({ limit: '6mb' }));

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

const askSchema = z
  .object({
    audio: z
      .object({
        /// Base64 without the data: prefix.
        data: z.string().min(100, 'That recording is empty').max(8_000_000, 'That recording is too long'),
        mediaType: z.string().regex(/^audio\/[\w.+-]+$/, 'That is not an audio recording'),
      })
      .optional(),
    /// Typed instead of spoken — the same pipeline, and the only way in when no
    /// speech key is configured.
    text: z.string().trim().min(2).max(500).optional(),
    /// Set when the operator answered a "which one did you mean?" prompt.
    pinnedPartyId: z.string().min(1).optional(),
    pinnedProductId: z.string().min(1).optional(),
  })
  .refine((body) => body.audio ?? body.text, { message: 'Say or type a question' });

/**
 * Asking the shop a question.
 *
 * Open to everyone who can view, because it answers nothing they could not read
 * off a screen — and the service is handed the role so it withholds the cost
 * figures that billing staff are not shown anywhere else either.
 */
aiRouter.post(
  '/ask',
  authorize(...CAN_VIEW),
  handler(async (req, res) => {
    const input = askSchema.parse(req.body);
    const { businessId, role } = scopeOf(req);

    res.json({
      answer: await askVoiceQuestion(
        businessId,
        {
          audio: input.audio
            ? { data: Buffer.from(input.audio.data, 'base64'), mediaType: input.audio.mediaType }
            : undefined,
          text: input.text,
          pinnedPartyId: input.pinnedPartyId,
          pinnedProductId: input.pinnedProductId,
        },
        { canSeeCost: CAN_SEE_COST.includes(role) },
      ),
    });
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
    // Two separate switches: without an AI key nothing works, and without a
    // speech key questions still work but have to be typed.
    res.json({ available: extractor.available, speech: transcriber.available });
  }),
);

aiRouter.use(
  handler(async () => {
    throw badRequest('Unknown AI endpoint');
  }),
);
