import type { Business, PrismaClient, User, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import {
  generateOpaqueToken,
  generateRefreshToken,
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
} from '../../lib/tokens.js';
import { validateGstin } from '../../lib/gstin.js';
import { currentFinancialYear } from '../../lib/financialYear.js';
import {
  badRequest,
  badRequestCoded,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../../lib/errors.js';
import type { CreateUserInput, LoginInput, RegisterInput } from './auth.schemas.js';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/// Exported so the message telling the recipient how long they have cannot
/// drift away from the value actually enforced.
export const PASSWORD_RESET_TTL_MINUTES = 30;

/// Units every paper shop needs on day one. conversionToBase is set per product
/// later — a ream of A4 and a ream of 100gsm art paper do not weigh the same.
const DEFAULT_UNITS = [
  { name: 'Ream', symbol: 'rm', uqc: 'NOS', allowDecimal: true },
  { name: 'Kilogram', symbol: 'kg', uqc: 'KGS', allowDecimal: true },
  { name: 'Packet', symbol: 'pkt', uqc: 'PAC', allowDecimal: true },
  { name: 'Sheet', symbol: 'sht', uqc: 'NOS', allowDecimal: false },
  { name: 'Bundle', symbol: 'bdl', uqc: 'BDL', allowDecimal: true },
  { name: 'Piece', symbol: 'pcs', uqc: 'NOS', allowDecimal: false },
];

/**
 * The user as the client is allowed to see it.
 *
 * An allowlist, not a denylist. Stripping known-secret fields and spreading the
 * rest fails open: the day someone adds a column to the User model, it ships to
 * every client until a human notices. Naming what goes out fails closed — a new
 * column is invisible until it is deliberately added here.
 *
 * Excluded on purpose, none of which the UI has any use for: `passwordHash`,
 * `totpSecret` and `recoveryCodes` (secrets), and `tokenVersion`,
 * `failedLoginCount`, `lockedUntil`, `totpEnabledAt`, `lastLoginIp` and
 * `deactivatedAt` (internal auth state — telling an attacker how many attempts
 * they have left, or exactly when a lockout expires, helps only them).
 */
export interface PublicUser {
  id: string;
  businessId: string;
  fullName: string;
  email: string | null;
  phone: string;
  role: User['role'];
  isActive: boolean;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * The business fields every auth response sends, in one place.
 *
 * `login` and `/me` used to select different sets — login omitted `stateCode`
 * and `stateName` — so a client had *less* information immediately after
 * signing in than after a page refresh, and anything reading the state code
 * silently got `undefined` until the next reload. The state code decides
 * CGST+SGST versus IGST, so that is not a field to be intermittent about.
 *
 * A shared `select` rather than three hand-written ones: the shapes cannot
 * drift apart if there is only one of them.
 */
export const PUBLIC_BUSINESS_SELECT = {
  id: true,
  legalName: true,
  tradeName: true,
  gstin: true,
  stateCode: true,
  stateName: true,
  city: true,
  phone: true,
  gstRegistrationType: true,
  fyStartMonth: true,
  hsnDigits: true,
  isActive: true,
} as const;

export type PublicBusiness = {
  -readonly [K in keyof typeof PUBLIC_BUSINESS_SELECT]: K extends keyof Business
    ? Business[K]
    : never;
};

/**
 * Projects a full Business row down to the same shape the `select` produces.
 *
 * Registration creates the row and therefore holds all of it — bank details,
 * e-way bill threshold, invoice terms. Returning that whole object made
 * `register` a third shape, different again from `login` and `/me`.
 */
function publicBusiness(business: Business): PublicBusiness {
  return {
    id: business.id,
    legalName: business.legalName,
    tradeName: business.tradeName,
    gstin: business.gstin,
    stateCode: business.stateCode,
    stateName: business.stateName,
    city: business.city,
    phone: business.phone,
    gstRegistrationType: business.gstRegistrationType,
    fyStartMonth: business.fyStartMonth,
    hsnDigits: business.hsnDigits,
    isActive: business.isActive,
  };
}

function sanitizeUser(user: User): PublicUser {
  return {
    id: user.id,
    businessId: user.businessId,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    emailVerifiedAt: user.emailVerifiedAt,
    phoneVerifiedAt: user.phoneVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/// One place that decides what "logged in" means, so login, refresh and
/// register cannot drift apart.
async function issueSession(
  db: PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  user: Pick<User, 'id' | 'businessId' | 'role' | 'tokenVersion'>,
  ctx: RequestContext,
  deviceName?: string,
): Promise<AuthTokens> {
  const refreshToken = generateRefreshToken();
  const expiresAt = refreshTokenExpiry();

  await db.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      deviceName: deviceName ?? null,
    },
  });

  return {
    accessToken: signAccessToken({
      sub: user.id,
      bid: user.businessId,
      role: user.role,
      tv: user.tokenVersion,
    }),
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Creates the firm, its owner, the default unit master and the invoice number
 * sequences — all in one transaction. A half-created business with no units is
 * worse than no business at all.
 */
export async function registerBusiness(input: RegisterInput, ctx: RequestContext) {
  const gstinCheck = validateGstin(input.business.gstin);
  if (!gstinCheck.valid) throw badRequest(gstinCheck.reason ?? 'Invalid GSTIN');

  const existing = await prisma.business.findUnique({
    where: { gstin: input.business.gstin },
    select: { id: true },
  });
  if (existing) throw conflict('A business with this GSTIN is already registered');

  const passwordHash = await hashPassword(input.owner.password);
  const financialYear = currentFinancialYear();

  const result = await prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        legalName: input.business.legalName,
        tradeName: input.business.tradeName ?? null,
        gstin: input.business.gstin,
        stateCode: gstinCheck.stateCode!,
        stateName: gstinCheck.stateName!,
        pan: gstinCheck.pan ?? null,
        addressLine1: input.business.addressLine1,
        addressLine2: input.business.addressLine2 ?? null,
        city: input.business.city,
        pincode: input.business.pincode,
        phone: input.business.phone,
        email: input.business.email ?? null,
      },
    });

    const owner = await tx.user.create({
      data: {
        businessId: business.id,
        fullName: input.owner.fullName,
        email: input.owner.email ?? null,
        phone: input.owner.phone,
        role: 'OWNER',
        passwordHash,
      },
    });

    await tx.unit.createMany({
      data: DEFAULT_UNITS.map((u) => ({ ...u, businessId: business.id })),
    });

    await tx.numberSequence.createMany({
      data: [
        { businessId: business.id, documentType: 'SALES_INVOICE' as const, financialYear, prefix: 'INV/', padding: 4 },
        { businessId: business.id, documentType: 'CREDIT_NOTE' as const, financialYear, prefix: 'CN/', padding: 4 },
        { businessId: business.id, documentType: 'DEBIT_NOTE' as const, financialYear, prefix: 'DN/', padding: 4 },
        { businessId: business.id, documentType: 'PAYMENT_RECEIPT' as const, financialYear, prefix: 'RCP/', padding: 4 },
        { businessId: business.id, documentType: 'DELIVERY_CHALLAN' as const, financialYear, prefix: 'DC/', padding: 4 },
      ],
    });

    await tx.auditLog.create({
      data: {
        businessId: business.id,
        userId: owner.id,
        action: 'business.register',
        entityType: 'Business',
        entityId: business.id,
        after: { gstin: business.gstin, legalName: business.legalName },
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });

    const tokens = await issueSession(tx, owner, ctx, 'Registration');
    return { business, owner, tokens };
  });

  return {
    business: publicBusiness(result.business),
    user: sanitizeUser(result.owner),
    tokens: result.tokens,
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function recordAttempt(
  identifier: string,
  successful: boolean,
  ctx: RequestContext,
  userId?: string,
  failReason?: string,
) {
  await prisma.loginAttempt.create({
    data: {
      identifier,
      successful,
      failReason: failReason ?? null,
      userId: userId ?? null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
}

export async function login(input: LoginInput, ctx: RequestContext) {
  const identifier = input.identifier.trim();
  const isEmail = identifier.includes('@');
  const normalizedPhone = identifier.replace(/[\s-]/g, '').replace(/^(\+91|0091|91|0)/, '');

  const user = await prisma.user.findFirst({
    where: isEmail
      ? { email: { equals: identifier, mode: 'insensitive' } }
      : { phone: normalizedPhone },
    include: { business: { select: PUBLIC_BUSINESS_SELECT } },
  });

  // Uniform failure for "no such user" and "wrong password" so the endpoint
  // can't be used to enumerate who has an account.
  const genericFailure = unauthorized('Invalid credentials');

  if (!user) {
    // Burn comparable time so response latency doesn't leak account existence.
    await hashPassword(input.password);
    await recordAttempt(identifier, false, ctx, undefined, 'USER_NOT_FOUND');
    throw genericFailure;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAttempt(identifier, false, ctx, user.id, 'LOCKED');
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw tooManyRequests(`Account locked. Try again in ${minutes} minute(s).`);
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= env.MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + env.LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    await recordAttempt(identifier, false, ctx, user.id, 'BAD_PASSWORD');
    if (shouldLock) {
      throw tooManyRequests(
        `Too many failed attempts. Account locked for ${env.LOCKOUT_MINUTES} minutes.`,
      );
    }
    throw genericFailure;
  }

  if (!user.isActive) {
    await recordAttempt(identifier, false, ctx, user.id, 'USER_INACTIVE');
    throw forbidden('This account has been deactivated');
  }
  if (!user.business.isActive) {
    await recordAttempt(identifier, false, ctx, user.id, 'BUSINESS_INACTIVE');
    throw forbidden('This business account is inactive');
  }

  // Transparently upgrade hashes created under older Argon2 parameters.
  const rehash = needsRehash(user.passwordHash) ? await hashPassword(input.password) : undefined;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ctx.ipAddress ?? null,
      ...(rehash ? { passwordHash: rehash } : {}),
    },
  });

  const tokens = await issueSession(prisma, updated, ctx, input.deviceName);
  await recordAttempt(identifier, true, ctx, user.id);

  return { user: sanitizeUser(updated), business: user.business, tokens };
}

// ---------------------------------------------------------------------------
// Refresh — rotation with reuse detection
// ---------------------------------------------------------------------------

/**
 * Every refresh mints a brand-new token and retires the old one. If a retired
 * token is ever presented again, the only explanations are a stolen cookie or a
 * cloned device — so we revoke the user's entire session tree rather than
 * guessing which side is legitimate.
 */
export async function refresh(rawToken: string, ctx: RequestContext): Promise<AuthTokens> {
  const tokenHash = hashToken(rawToken);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
    include: { user: { include: { business: { select: { isActive: true } } } } },
  });

  if (!session) throw unauthorized('Invalid refresh token');

  if (session.revokedAt || session.replacedBySessionId) {
    // Reuse detected.
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE_DETECTED' },
    });
    await prisma.auditLog.create({
      data: {
        businessId: session.user.businessId,
        userId: session.userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'Session',
        entityId: session.id,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
    throw unauthorized('Session revoked. Please sign in again.');
  }

  if (session.expiresAt <= new Date()) throw unauthorized('Session expired. Please sign in again.');
  if (!session.user.isActive || !session.user.business.isActive) {
    throw forbidden('This account is no longer active');
  }

  const newToken = generateRefreshToken();
  const expiresAt = refreshTokenExpiry();

  await prisma.$transaction(async (tx) => {
    const created = await tx.session.create({
      data: {
        userId: session.userId,
        refreshTokenHash: hashToken(newToken),
        expiresAt,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        deviceName: session.deviceName,
      },
    });
    await tx.session.update({
      where: { id: session.id },
      data: {
        replacedBySessionId: created.id,
        revokedAt: new Date(),
        revokedReason: 'ROTATED',
        lastUsedAt: new Date(),
      },
    });
  });

  return {
    accessToken: signAccessToken({
      sub: session.user.id,
      bid: session.user.businessId,
      role: session.user.role,
      tv: session.user.tokenVersion,
    }),
    refreshToken: newToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(rawToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT' },
  });
}

/// Kills every device and invalidates outstanding access tokens by bumping
/// tokenVersion — the JWTs themselves cannot be recalled.
export async function logoutAll(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT_ALL' },
    }),
    prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
  ]);
}

export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      deviceName: true,
      userAgent: true,
      ipAddress: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { lastUsedAt: 'desc' },
  });
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
  });
  if (result.count === 0) throw notFound('Session not found');
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw unauthorized('Current password is incorrect');
  }
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw badRequest('New password must be different from the current one');
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    }),
    // A password change means every other device is signed out.
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    }),
    prisma.auditLog.create({
      data: {
        businessId: user.businessId,
        userId,
        action: 'user.password_change',
        entityType: 'User',
        entityId: userId,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    }),
  ]);
}

/**
 * Always resolves successfully, whether or not the identifier matched — a
 * "no such account" response here is an account-enumeration oracle. The caller
 * sends the returned token out of band; it is never in the HTTP response.
 */
export async function requestPasswordReset(
  identifier: string,
  ctx: RequestContext,
): Promise<{ token: string; user: User } | null> {
  const isEmail = identifier.includes('@');
  const normalizedPhone = identifier.replace(/[\s-]/g, '').replace(/^(\+91|0091|91|0)/, '');

  const user = await prisma.user.findFirst({
    where: isEmail
      ? { email: { equals: identifier, mode: 'insensitive' } }
      : { phone: normalizedPhone },
  });
  if (!user || !user.isActive) return null;

  const token = generateOpaqueToken(32);

  await prisma.$transaction([
    // Only the newest reset link should work. Recorded as supersession rather
    // than use, so the screen can tell someone holding the older email that a
    // newer one exists instead of implying their link simply broke.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, supersededAt: null },
      data: { supersededAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
        ipAddress: ctx.ipAddress ?? null,
      },
    }),
  ]);

  return { token, user };
}

export async function resetPassword(
  rawToken: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  /**
   * Four ways a link fails, and they are not interchangeable.
   *
   * "Invalid or has expired" covered all of them and told the reader nothing:
   * whether to open a different email, request a new link, or stop because
   * their password already changed. Worse, an unrecognised token is what you
   * get when a link points at the wrong deployment — which happened, and the
   * single message hid it for hours.
   *
   * Ordered so the most specific answer wins. Unrecognised is deliberately
   * last-resort wording: it says nothing about whether the account exists.
   */
  if (!record) {
    throw badRequestCoded(
      'RESET_TOKEN_UNKNOWN',
      'This reset link is not recognised. Check you opened the most recent email, and that the link was not cut short by your mail app.',
    );
  }
  if (record.usedAt) {
    throw badRequestCoded(
      'RESET_TOKEN_USED',
      'This link has already been used to change the password. Sign in with the new one, or ask for another link.',
    );
  }
  if (record.supersededAt) {
    throw badRequestCoded(
      'RESET_TOKEN_SUPERSEDED',
      'A newer reset link was requested after this one, which replaced it. Open the most recent email instead.',
    );
  }
  if (record.expiresAt <= new Date()) {
    throw badRequestCoded(
      'RESET_TOKEN_EXPIRED',
      `This link has expired — they last ${PASSWORD_RESET_TTL_MINUTES} minutes. Request a new one.`,
    );
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        tokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
    }),
    prisma.auditLog.create({
      data: {
        businessId: record.user.businessId,
        userId: record.userId,
        action: 'user.password_reset',
        entityType: 'User',
        entityId: record.userId,
        ipAddress: ctx.ipAddress ?? null,
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Staff accounts (OWNER only)
// ---------------------------------------------------------------------------

export async function createStaffUser(
  businessId: string,
  actorId: string,
  input: CreateUserInput,
  ctx: RequestContext,
) {
  const clash = await prisma.user.findFirst({
    where: {
      businessId,
      OR: [{ phone: input.phone }, ...(input.email ? [{ email: input.email }] : [])],
    },
    select: { id: true },
  });
  if (clash) throw conflict('A user with this phone or email already exists in this business');

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      businessId,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone,
      role: input.role,
      passwordHash,
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: actorId,
      action: 'user.create',
      entityType: 'User',
      entityId: user.id,
      after: { fullName: user.fullName, phone: user.phone, role: user.role },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });

  return sanitizeUser(user);
}

export async function listUsers(businessId: string) {
  const users = await prisma.user.findMany({
    where: { businessId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
  });
  return users.map(sanitizeUser);
}

/**
 * The owner sets a staff member's password directly.
 *
 * The realistic answer to "I forgot my password" in a shop: SMS to an Indian
 * mobile needs DLT registration, most counter staff have no email address, and
 * the owner is standing right there.
 *
 * Bumping `tokenVersion` signs the staff member out everywhere immediately —
 * necessary, because the reason for setting a password is often that someone
 * else knows the old one.
 */
export async function setStaffPassword(
  businessId: string,
  actorId: string,
  targetUserId: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const target = await prisma.user.findFirst({ where: { id: targetUserId, businessId } });
  if (!target) throw notFound('User not found');

  // Your own password goes through change-password, which demands the current
  // one. Otherwise a borrowed unlocked session could lock the real owner out.
  if (target.id === actorId) {
    throw badRequest('Use change password for your own account');
  }

  // One owner cannot seize another owner's account. Two owners disagreeing is
  // a conversation, not a support feature.
  if (target.role === 'OWNER') {
    throw forbidden("An owner's password cannot be set by someone else");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: targetUserId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    }),
    // Any reset link already in flight must stop working.
    prisma.passwordResetToken.updateMany({
      where: { userId: targetUserId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.session.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        businessId,
        userId: actorId,
        action: 'user.password_set_by_owner',
        entityType: 'User',
        entityId: targetUserId,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    }),
  ]);
}

export async function updateUser(
  businessId: string,
  actorId: string,
  targetUserId: string,
  patch: { fullName?: string; role?: UserRole; isActive?: boolean },
  ctx: RequestContext,
) {
  const target = await prisma.user.findFirst({ where: { id: targetUserId, businessId } });
  if (!target) throw notFound('User not found');

  // Guard against the firm locking itself out of its own account.
  const demotingOrDisablingAnOwner =
    target.role === 'OWNER' && (patch.role !== undefined || patch.isActive === false);
  if (demotingOrDisablingAnOwner) {
    const otherOwners = await prisma.user.count({
      where: { businessId, role: 'OWNER', isActive: true, id: { not: targetUserId } },
    });
    if (otherOwners === 0) throw badRequest('The business must have at least one active owner');
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.isActive !== undefined
        ? {
            isActive: patch.isActive,
            deactivatedAt: patch.isActive ? null : new Date(),
            // Deactivating must take effect immediately, not in 15 minutes.
            ...(patch.isActive ? {} : { tokenVersion: { increment: 1 } }),
          }
        : {}),
    },
  });

  if (patch.isActive === false) {
    await prisma.session.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER_DEACTIVATED' },
    });
  }

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: actorId,
      action: 'user.update',
      entityType: 'User',
      entityId: targetUserId,
      before: { fullName: target.fullName, role: target.role, isActive: target.isActive },
      after: { fullName: updated.fullName, role: updated.role, isActive: updated.isActive },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });

  return sanitizeUser(updated);
}

/**
 * A user maintaining their own name and email.
 *
 * The email is the point. Password reset can only reach an account that has
 * one — an account with only a phone number has no delivery channel at all
 * while SMS is blocked behind DLT registration. For staff that is survivable,
 * because the owner can set their password from Settings → Staff. For the
 * **owner** it is not: nobody can reset the owner, so an owner with no email
 * and a forgotten password locks the shop out of its own books entirely.
 *
 * Deliberately narrow. Role and active status are the owner's to change, not
 * your own, or any billing clerk could promote themselves.
 */
export async function updateOwnProfile(
  userId: string,
  patch: { fullName?: string; email?: string | null },
  ctx: RequestContext,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');

  if (patch.email) {
    const clash = await prisma.user.findFirst({
      where: {
        businessId: user.businessId,
        email: { equals: patch.email, mode: 'insensitive' },
        id: { not: userId },
      },
      select: { id: true },
    });
    if (clash) throw conflict('Someone else in this shop already uses that email');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
      ...(patch.email !== undefined
        ? {
            email: patch.email,
            // A changed address has not been proved to belong to them, and the
            // old verification certainly does not carry over.
            emailVerifiedAt: null,
          }
        : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId: user.businessId,
      userId,
      action: 'user.self_update',
      entityType: 'User',
      entityId: userId,
      before: { fullName: user.fullName, email: user.email },
      after: { fullName: updated.fullName, email: updated.email },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });

  return sanitizeUser(updated);
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      business: {
        select: PUBLIC_BUSINESS_SELECT,
      },
    },
  });
  if (!user) throw notFound('User not found');
  const { business, ...rest } = user;
  return { user: sanitizeUser(rest as User), business };
}
