import { z } from 'zod';
import { email, phone } from './common';

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a number');

export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Email or phone is required'),
  password: z.string().min(1, 'Password is required'),
  tenantSlug: z.string().trim().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email,
  phone,
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const sendOtpSchema = z.object({ phone, tenantSlug: z.string().trim().optional() });
export const verifyOtpSchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6 digit code'),
  tenantSlug: z.string().trim().optional(),
});
export const googleLoginSchema = z.object({ idToken: z.string().min(10), tenantSlug: z.string().optional() });
export const refreshSchema = z.object({ refreshToken: z.string().min(10).optional() });
export const acceptInviteSchema = z.object({ token: z.string().min(10), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });
export const adminLoginSchema = z.object({ email, password: z.string().min(1) });
