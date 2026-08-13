import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { validateGstin } from '../../lib/gstin.js';

/// Indian mobile: 10 digits starting 6-9. Accepts and strips +91 / 0 prefixes
/// because that is how numbers actually get typed.
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|0091|91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'));

/// Length beats composition rules — a 12-character passphrase is stronger than
/// "Pass@123" and far likelier to be remembered rather than written on the wall.
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((value, ctx) => {
    const result = validateGstin(value);
    if (!result.valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? 'Invalid GSTIN' });
    }
  });

export const registerSchema = z.object({
  business: z.object({
    legalName: z.string().trim().min(2).max(200),
    tradeName: z.string().trim().max(200).optional(),
    gstin: gstinSchema,
    addressLine1: z.string().trim().min(3).max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(100),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    phone: phoneSchema,
    email: z.string().email().optional(),
  }),
  owner: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().email().optional(),
    phone: phoneSchema,
    password: passwordSchema,
  }),
});

export const loginSchema = z.object({
  /// Email or phone — the shop staff will use whichever they remember.
  identifier: z.string().trim().min(3),
  password: z.string().min(1, 'Password is required'),
  deviceName: z.string().trim().max(100).optional(),
});

export const refreshSchema = z.object({
  /// Falls back to the httpOnly cookie when absent (browser clients).
  refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().optional(),
  phone: phoneSchema,
  password: passwordSchema,
  role: z.nativeEnum(UserRole),
});

/// The owner setting a staff member's password. Same strength rule as anywhere
/// else — a temporary password is still a password.
export const setUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
