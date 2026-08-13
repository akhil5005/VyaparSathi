import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /// Where the frontend lives. Used for links in emails and as the default
  /// CORS origin.
  APP_URL: z.string().url().default('http://localhost:5173'),
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
 * Every browser origin allowed to call the API, deduplicated.
 *
 * An origin is scheme + host + port and nothing more — a trailing slash or a
 * path makes it not match, which is the usual cause of a CORS failure that
 * looks inexplicable, so they are stripped here rather than in configuration.
 */
export const allowedOrigins: string[] = [
  ...new Set(
    [env.APP_URL, ...(env.CORS_ORIGINS?.split(',') ?? [])]
      .map((value) => value.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  ),
];
