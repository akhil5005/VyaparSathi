import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string; // userId
  bid: string; // businessId
  role: UserRole;
  /// Mirrors User.tokenVersion. A password change or "log out everywhere" bumps
  /// the stored value, invalidating every access token already in the wild
  /// without needing a per-request session lookup.
  tv: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'gstcal',
    audience: 'gstcal-api',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'gstcal',
    audience: 'gstcal-api',
  }) as AccessTokenPayload;
}

/// Refresh tokens are opaque random bytes, not JWTs — they must be revocable,
/// and a self-describing token cannot be revoked without a DB lookup anyway.
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/// Only the hash is stored. SHA-256 rather than Argon2 because the input is
/// already 48 bytes of entropy — there is nothing to brute-force, and this is
/// on the hot path of every refresh.
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/// 6-digit OTP for phone verification.
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

export const refreshTokenExpiry = (): Date =>
  new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
