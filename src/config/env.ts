import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * Where the frontend lives. Used for links in emails and as the default CORS
   * origin.
   *
   * **No default.** It used to default to `http://localhost:5173`, which was
   * convenient in development and quietly catastrophic in production: a
   * deployment that never set it emailed every password reset link pointing at
   * localhost. The link opened the developer's own machine, hit a different
   * database, and reported "this reset link is invalid or has expired" — while
   * the real token sat unused on the server, looking perfectly healthy.
   *
   * Left unset, `appUrl` below falls back to the host the request arrived on,
   * which is right for a single-origin deployment and cannot point somewhere
   * the user is not.
   */
  APP_URL: z.string().url().optional(),
  /**
   * Extra browser origins allowed to call this API, comma-separated.
   *
   * The frontend is served from its own subdomain (app.example.me) while the
   * API sits on another (api.example.me), so every request from the browser is
   * cross-origin and needs an explicit allow. Subdomains of one registrable
   * domain are still the same *site*, which is why the refresh cookie can stay
   * SameSite=Lax and never becomes a third-party cookie.
   *
   * APP_URL is always allowed; this is for the extras — a preview deployment,
   * or the Vite dev server when pointing at a deployed API.
   */
  CORS_ORIGINS: z.string().optional(),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // ---- Outbound messages ----
  /**
   * Resend API key. When set together with MAIL_FROM, password reset links are
   * emailed; otherwise they are only logged, which in production means nobody
   * receives them.
   *
   * Not SMS: reaching an Indian mobile requires DLT registration of the sender
   * ID and every template under the TRAI mandate, which needs a registered
   * business and several days. See src/lib/notifier.ts.
   */
  RESEND_API_KEY: z.string().optional(),
  /// e.g. "Vyapar Sathi <noreply@yourdomain.com>". Resend requires the domain
  /// to be verified before it will deliver to arbitrary recipients.
  MAIL_FROM: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ASR_PROVIDER: z.enum(['sarvam', 'openai']).default('sarvam'),
  SARVAM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail at boot, not at the first request. Flatten so the message names every
  // missing variable at once instead of one per restart.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';

/**
 * The frontend's origin, or undefined when the request should decide.
 *
 * Development keeps the old convenience — Vite is on 5173 and the API on 4000,
 * so there is a real second origin and guessing it from the request would be
 * wrong. Production gets no guess at all: either it is configured, or the link
 * is built from the host the browser actually reached.
 */
export function resolveAppUrl(
  configured: string | undefined,
  production: boolean,
): string | undefined {
  return configured ?? (production ? undefined : 'http://localhost:5173');
}

export const appUrl: string | undefined = resolveAppUrl(env.APP_URL, isProduction);

if (isProduction && appUrl && /localhost|127\.0\.0\.1/.test(appUrl)) {
  // Nothing good comes of this, and it is invisible until someone follows a
  // link — so say it at boot, where it will be seen in the deploy log.
  console.warn(
    `APP_URL is set to "${appUrl}" in production. Every emailed link will point ` +
      'at the machine of whoever opens it. Set it to the public URL, or unset it and ' +
      'let links be built from the request host.',
  );
}

/**
 * Every browser origin allowed to call the API, deduplicated.
 *
 * An origin is scheme + host + port and nothing more — a trailing slash or a
 * path makes it not match, which is the usual cause of a CORS failure that
 * looks inexplicable, so they are stripped here rather than in configuration.
 */
export const allowedOrigins: string[] = [
  ...new Set(
    [appUrl, ...(env.CORS_ORIGINS?.split(',') ?? [])]
      // appUrl is undefined on a single-origin deployment, where there is no
      // cross-origin caller to allow in the first place.
      .map((value) => (value ?? '').trim().replace(/\/+$/, ''))
      .filter(Boolean),
  ),
];
