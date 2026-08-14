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

/**
 * *Asking* for a reset link.
 *
 * Expensive — it sends a real email — and enumerable, since the identifier is
 * chosen by the caller. Keyed on IP alone rather than IP + identifier, because
 * enumeration works by varying the identifier: giving each new one a fresh
 * budget would defeat the whole point.
 */
export const passwordResetLimiter = () =>
  rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: jsonError(
      'TOO_MANY_REQUESTS',
      'Too many reset links requested from here. Try again in an hour, or ask the shop owner to set your password.',
    ),
  });

/**
 * *Using* a reset link, which is a completely different risk and must have its
 * own budget.
 *
 * These two shared one limiter at first, and the result was the worst possible
 * failure: request a few links while something downstream is misconfigured,
 * finally receive a good one, and then be refused permission to spend it — a
 * valid token, an unusable account, and an error message about "too many
 * requests" that describes something the person is no longer doing.
 *
 * Redeeming a link cannot be enumerated: the token is 32 random bytes, so
 * guessing one is not a thing that happens. This exists only so a brute-force
 * attempt is not free, which means it can be far looser. Successful redemptions
 * are not counted at all — a limit on *succeeding* protects nobody, and would
 * punish someone who mistyped the confirmation box twice.
 */
export const passwordResetConfirmLimiter = () =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: jsonError(
      'TOO_MANY_REQUESTS',
      'Too many attempts with a reset link. Try again in fifteen minutes.',
    ),
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
      passwordResetConfirm: passThrough,
      register: passThrough,
    };
  }
  return {
    global: globalLimiter(),
    auth: authLimiter(),
    passwordReset: passwordResetLimiter(),
    passwordResetConfirm: passwordResetConfirmLimiter(),
    register: registerLimiter(),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
