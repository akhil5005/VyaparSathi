import type { Request, RequestHandler, Response } from 'express';
import { env, isProduction } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notifier } from '../../lib/notifier.js';
import * as authService from './auth.service.js';
import {
  changePasswordSchema,
  createUserSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  setUserPasswordSchema,
  updateOwnProfileSchema,
  updateUserSchema,
} from './auth.schemas.js';

const REFRESH_COOKIE = 'vyapar_rt';

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

export const updateMe = handler(async (req, res) => {
  const patch = updateOwnProfileSchema.parse(req.body);
  res.json({
    user: await authService.updateOwnProfile(req.auth!.userId, patch, contextOf(req)),
  });
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
    /**
     * `APP_URL` is the frontend's origin. In a single-origin deployment the
     * frontend is this same server, so fall back to the request's own host
     * rather than sending a link to wherever APP_URL happened to be left
     * pointing — a reset link to the wrong host is a reset link to nowhere.
     */
    const base = env.APP_URL || `${req.protocol}://${req.get('host')}`;

    const delivery = await notifier.sendPasswordReset({
      to: result.user.email ?? result.user.phone,
      channel: result.user.email ? 'email' : 'sms',
      recipientName: result.user.fullName,
      resetUrl: `${base}/reset-password?token=${result.token}`,
      expiresInMinutes: authService.PASSWORD_RESET_TTL_MINUTES,
    });

    if (!delivery.delivered) {
      // Logged, never returned. Telling the requester that delivery failed
      // would confirm the account exists, which is exactly what the uniform
      // response below is protecting.
      logger.error(
        { via: delivery.via, reason: delivery.reason, userId: result.user.id },
        'Password reset link could not be delivered',
      );
    }
  }

  /**
   * Whether this deployment can deliver at all is a property of the *server*,
   * not of any account, so saying it leaks nothing — and not saying it is a
   * lie. Without a notifier configured the message below is false for
   * everyone, and the person sits refreshing an inbox that will never receive
   * anything. The screen uses this to point them at the owner instead.
   */
  // Identical response either way — otherwise this endpoint tells an attacker
  // which phone numbers have accounts.
  const canDeliver = notifier.name !== 'console';
  res.json({
    message: canDeliver
      ? 'If that account exists, a reset link has been sent.'
      : 'This shop has no email delivery set up, so no link can be sent.',
    deliveryConfigured: canDeliver,
  });
});

/**
 * The owner sets a staff member's password directly.
 *
 * This is the path that actually works in an Indian shop. Reaching a mobile by
 * SMS needs DLT registration, most counter staff have no email, and the owner
 * is standing next to them anyway — so the honest answer to "I forgot my
 * password" is the owner setting a new one and saying it out loud.
 *
 * Owner-only, and it cannot target another owner or the owner themselves:
 * changing your own password goes through `change-password`, which requires
 * knowing the current one.
 */
export const setUserPassword = handler(async (req, res) => {
  const { newPassword } = setUserPasswordSchema.parse(req.body);
  await authService.setStaffPassword(
    req.auth!.businessId,
    req.auth!.userId,
    req.params.userId!,
    newPassword,
    contextOf(req),
  );
  res.json({ message: 'Password set. Tell them the new password — they can change it after signing in.' });
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
