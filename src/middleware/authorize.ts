import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * Role gate. Mount after `authenticate`.
 *
 *   router.post('/users', authenticate, authorize('OWNER'), controller.create)
 */
export function authorize(...allowed: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!allowed.includes(req.auth.role)) {
      return next(forbidden('Your role does not allow this action'));
    }
    next();
  };
}

/// Named bundles so route files read as intent rather than role arithmetic.
export const CAN_MANAGE_USERS: UserRole[] = ['OWNER'];
export const CAN_EDIT_MASTERS: UserRole[] = ['OWNER', 'MANAGER'];
export const CAN_BILL: UserRole[] = ['OWNER', 'MANAGER', 'BILLING_STAFF'];
export const CAN_RECEIVE_PAYMENT: UserRole[] = ['OWNER', 'MANAGER', 'BILLING_STAFF', 'ACCOUNTANT'];
export const CAN_VIEW: UserRole[] = ['OWNER', 'MANAGER', 'BILLING_STAFF', 'ACCOUNTANT', 'VIEWER'];
/// Cost price and margin are owner-and-manager information.
export const CAN_SEE_COST: UserRole[] = ['OWNER', 'MANAGER', 'ACCOUNTANT'];
/// GST returns. A counter clerk has no business exporting the sales register.
export const CAN_FILE_RETURNS: UserRole[] = ['OWNER', 'MANAGER', 'ACCOUNTANT'];
