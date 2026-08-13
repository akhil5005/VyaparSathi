import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { verifyAccessToken } from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import { unauthorized } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessId: string;
        role: UserRole;
      };
    }
  }
}

/**
 * Verifies the access token and confirms it hasn't been invalidated.
 *
 * The tokenVersion check costs one indexed lookup per request but is what makes
 * "log out everywhere", deactivation and password changes take effect
 * immediately instead of after the token's 15-minute lifetime.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');

    const token = header.slice(7).trim();
    if (!token) throw unauthorized('Missing bearer token');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const name = (err as Error).name;
      throw unauthorized(name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid token');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        businessId: true,
        role: true,
        tokenVersion: true,
        isActive: true,
        business: { select: { isActive: true } },
      },
    });

    if (!user || !user.isActive || !user.business.isActive) {
      throw unauthorized('Account is no longer active');
    }
    if (user.tokenVersion !== payload.tv) {
      throw unauthorized('Session is no longer valid. Please sign in again.');
    }

    req.auth = { userId: user.id, businessId: user.businessId, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}
