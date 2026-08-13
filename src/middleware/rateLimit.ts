import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

/**
 * Rate limiters.
 *
 * These are *factories*, not shared instances. Each limiter keeps its counters
 * in memory, so a module-level singleton would be global to the process — fine
 * in production, where there is exactly one app, but it means two apps in one
 * test run would share and pollute each other's counts, and a test that
 * deliberately trips a limit would leave it tripped for everything after.
 * Building them per app keeps that state where it belongs.
 */

const jsonError = (code: string, message: string) => ({ error: { code, message } });

/// Never rate-limits. Used when an app is built with limiting switched off.
const passThrough: RequestHandler = (_req, _res, next) => next();

/// Broad ceiling for the whole API.
export const globalLimiter = () =>
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: jsonError('TOO_MANY_REQUESTS', 'Too many requests. Slow down a moment.'),
  });

/**
 * Login/refresh throttle.
 *
 * Keyed on IP + identifier rather than IP alone: a whole shop behind one
 * connection shouldn't lock each other out, but a password-spray against one
 * account still gets stopped. Per-account lockout in the service layer is the
 * second line of defence.
 */
export const authLimiter = () =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req: Request) => {
      const identifier = String(
        (req.body as { identifier?: unknown })?.identifier ?? '',
      ).toLowerCase();
      return `${req.ip}:${identifier}`;
    },
    message: jsonError(
      'TOO_MANY_REQUESTS',
      'Too many sign-in attempts. Try again in a few minutes.',
    ),
  });

/// Password reset is expensive (sends SMS/email) and enumerable — keep it tight.
export const passwordResetLimiter = () =>
  rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: jsonError('TOO_MANY_REQUESTS', 'Too many reset requests. Try again later.'),
  });

/// Registration creates tenants — one every few minutes per IP is plenty.
export const registerLimiter = () =>
  rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: jsonError('TOO_MANY_REQUESTS', 'Too many registration attempts. Try again later.'),
  });

/**
 * The set of limiters one app instance uses.
 *
 * `enabled: false` swaps every one for a pass-through. That is only for tests
 * that need to make hundreds of calls — a test suite would exhaust the
 * five-registrations-per-hour budget on its third case otherwise. The limits
 * themselves are still proven, by a test that builds an app with them on.
 */
export function buildLimiters(enabled: boolean) {
  if (!enabled) {
    return {
      global: passThrough,
      auth: passThrough,
      passwordReset: passThrough,
      register: passThrough,
    };
  }
  return {
    global: globalLimiter(),
    auth: authLimiter(),
    passwordReset: passwordResetLimiter(),
    register: registerLimiter(),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
