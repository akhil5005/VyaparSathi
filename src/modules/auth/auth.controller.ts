import type { Request, RequestHandler, Response } from 'express';
import { env, isProduction } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import * as authService from './auth.service.js';
import {
  changePasswordSchema,
  createUserSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updateUserSchema,
} from './auth.schemas.js';

const REFRESH_COOKIE = 'gstcal_rt';

const contextOf = (req: Request): authService.RequestContext => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

/**
 * The refresh token goes in an httpOnly cookie so browser JavaScript — and
 * therefore any XSS payload — cannot read it. Native/mobile clients get the
 * same token in the JSON body and store it in the OS keychain instead.
 */
function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    expires: expiresAt,
    path: '/api/auth',
  });
}

const clearRefreshCookie = (res: Response) =>
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

/// Small wrapper so async throws reach the error middleware instead of
/// becoming unhandled rejections.
const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const register = handler(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const { business, user, tokens } = await authService.registerBusiness(input, contextOf(req));

  setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
  res.status(201).json({
    business,
    user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
});

export const login = handler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const { user, business, tokens } = await authService.login(input, contextOf(req));

  setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
  res.json({
    user,
    business,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
});

export const refresh = handler(async (req, res) => {
  const body = refreshSchema.parse(req.body ?? {});
  const token = body.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
  if (!token) throw unauthorized('No refresh token supplied');

  const tokens = await authService.refresh(token, contextOf(req));

  setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
  res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
});

export const logout = handler(async (req, res) => {
  const token =
    (req.body as { refreshToken?: string } | undefined)?.refreshToken ??
    (req.cookies?.[REFRESH_COOKIE] as string | undefined);
  if (token) await authService.logout(token);

  clearRefreshCookie(res);
  res.status(204).send();
});

export const logoutAll = handler(async (req, res) => {
  await authService.logoutAll(req.auth!.userId);
  clearRefreshCookie(res);
  res.status(204).send();
});

export const me = handler(async (req, res) => {
  res.json(await authService.getProfile(req.auth!.userId));
});

export const changePassword = handler(async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  await authService.changePassword(req.auth!.userId, currentPassword, newPassword, contextOf(req));

  clearRefreshCookie(res);
  res.json({ message: 'Password changed. Please sign in again on your other devices.' });
});

export const forgotPassword = handler(async (req, res) => {
  const { identifier } = forgotPasswordSchema.parse(req.body);
  const result = await authService.requestPasswordReset(identifier, contextOf(req));

  if (result) {
    // TODO: deliver via WhatsApp/SMS for phone identifiers, email otherwise.
    // Logging the link is a development affordance only — this branch must be
    // replaced before the app is exposed to the internet.
    if (!isProduction) {
      logger.info(
        { resetUrl: `${env.APP_URL}/reset-password?token=${result.token}` },
        'Password reset link (dev only)',
      );
    }
  }

  // Identical response either way — otherwise this endpoint tells an attacker
  // which phone numbers have accounts.
  res.json({
    message: 'If that account exists, a reset link has been sent.',
  });
});

export const resetPassword = handler(async (req, res) => {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(token, newPassword, contextOf(req));
  res.json({ message: 'Password reset. You can now sign in.' });
});

export const listSessions = handler(async (req, res) => {
  res.json({ sessions: await authService.listSessions(req.auth!.userId) });
});

export const revokeSession = handler(async (req, res) => {
  await authService.revokeSession(req.auth!.userId, req.params.sessionId!);
  res.status(204).send();
});

// ---- Staff management (OWNER only) ----

export const createUser = handler(async (req, res) => {
  const input = createUserSchema.parse(req.body);
  const user = await authService.createStaffUser(
    req.auth!.businessId,
    req.auth!.userId,
    input,
    contextOf(req),
  );
  res.status(201).json({ user });
});

export const listUsers = handler(async (req, res) => {
  res.json({ users: await authService.listUsers(req.auth!.businessId) });
});

export const updateUser = handler(async (req, res) => {
  const patch = updateUserSchema.parse(req.body);
  const user = await authService.updateUser(
    req.auth!.businessId,
    req.auth!.userId,
    req.params.userId!,
    patch,
    contextOf(req),
  );
  res.json({ user });
});
