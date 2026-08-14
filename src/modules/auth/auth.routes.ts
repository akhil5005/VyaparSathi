import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_MANAGE_USERS } from '../../middleware/authorize.js';
import { buildLimiters, type Limiters } from '../../middleware/rateLimit.js';
import * as controller from './auth.controller.js';

/**
 * Built per app rather than exported as a singleton, because the limiters it
 * mounts hold per-instance counters. See `middleware/rateLimit.ts`.
 */
export function createAuthRouter(limiters: Limiters = buildLimiters(true)): Router {
  const authRouter = Router();

  // ---- Public ----
  authRouter.post('/register', limiters.register, controller.register);
  authRouter.post('/login', limiters.auth, controller.login);
  authRouter.post('/refresh', limiters.auth, controller.refresh);
  authRouter.post('/logout', controller.logout);
  authRouter.post('/forgot-password', limiters.passwordReset, controller.forgotPassword);
  authRouter.post('/reset-password', limiters.passwordReset, controller.resetPassword);

  // ---- Authenticated ----
  authRouter.get('/me', authenticate, controller.me);
  authRouter.patch('/me', authenticate, controller.updateMe);
  authRouter.post('/change-password', authenticate, controller.changePassword);
  authRouter.post('/logout-all', authenticate, controller.logoutAll);
  authRouter.get('/sessions', authenticate, controller.listSessions);
  authRouter.delete('/sessions/:sessionId', authenticate, controller.revokeSession);

  // ---- Owner only ----
  authRouter.get('/users', authenticate, authorize(...CAN_MANAGE_USERS), controller.listUsers);
  authRouter.post('/users', authenticate, authorize(...CAN_MANAGE_USERS), controller.createUser);
  authRouter.post(
    '/users/:userId/set-password',
    authenticate,
    authorize(...CAN_MANAGE_USERS),
    controller.setUserPassword,
  );
  authRouter.patch(
    '/users/:userId',
    authenticate,
    authorize(...CAN_MANAGE_USERS),
    controller.updateUser,
  );

  return authRouter;
}
