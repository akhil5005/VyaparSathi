import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { allowedOrigins } from './config/env.js';
import { logger } from './lib/logger.js';
import { buildLimiters } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { salesInvoiceRouter } from './modules/invoices/salesInvoice.routes.js';
import { mastersRouter } from './modules/masters/masters.routes.js';
import { paymentRouter } from './modules/payments/payment.routes.js';
import { purchaseRouter } from './modules/purchases/purchase.routes.js';
import { noteRouter } from './modules/notes/creditNote.routes.js';
import { printRouter } from './modules/printing/print.routes.js';

export interface AppOptions {
  /**
   * Off only for tests that make hundreds of calls — the registration limiter
   * allows five per hour, which a suite exhausts on its third case. Production
   * and development always leave this on.
   */
  enableRateLimit?: boolean;
  /// Request logging is noise in a test run.
  enableRequestLogging?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const { enableRateLimit = true, enableRequestLogging = true } = options;
  const app = express();

  // Behind nginx/Render/Railway, req.ip must come from X-Forwarded-For or every
  // rate limiter keys on the proxy's address and throttles the whole shop at once.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      /**
       * helmet defaults this to `same-origin`, which is right for a site and
       * wrong for an API deliberately served from another origin.
       *
       * CORP governs `no-cors` loads — an <img>, an <iframe>, a window opened
       * on a URL. A `fetch` in CORS mode is judged by the CORS headers instead,
       * so JSON would survive either way, but opening an invoice PDF in a new
       * tab is exactly a no-cors navigation and `same-origin` blocks it.
       */
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      /**
       * A function rather than a list so the rejection is a plain "no CORS
       * headers" — the browser then blocks the response itself. Throwing here
       * would return a 500, which looks like a server fault rather than a
       * misconfigured origin.
       *
       * A missing Origin header (curl, a health check, a same-origin request)
       * is allowed through: CORS is a browser rule and there is no browser to
       * protect. It is not an authentication check — `authenticate` is.
       */
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      // Without this the browser drops the refresh cookie on every
      // cross-origin call, and staying signed in stops working.
      credentials: true,
      // 24h — stops the browser re-running a preflight before every mutation.
      maxAge: 86_400,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  if (enableRequestLogging) app.use(pinoHttp({ logger }));

  const limiters = buildLimiters(enableRateLimit);
  app.use(limiters.global);

  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.use('/api/auth', createAuthRouter(limiters));
  app.use('/api/masters', mastersRouter);
  app.use('/api/sales-invoices', salesInvoiceRouter);
  app.use('/api/purchases', purchaseRouter);
  app.use('/api/payments', paymentRouter);
  app.use('/api/notes', noteRouter);
  app.use('/api/printing', printRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
