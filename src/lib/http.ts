import type { Request, RequestHandler, Response } from 'express';
import type { RequestContext } from '../modules/auth/auth.service.js';

/**
 * Wraps an async route so a thrown error reaches the error middleware instead
 * of becoming an unhandled rejection that silently hangs the request.
 */
export const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const contextOf = (req: Request): RequestContext => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

/// Every masters route is scoped to the caller's business. Reading these off
/// `req.auth` in one place means no route can forget the tenant filter.
export const scopeOf = (req: Request) => ({
  businessId: req.auth!.businessId,
  userId: req.auth!.userId,
  role: req.auth!.role,
});
