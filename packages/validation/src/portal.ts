import { z } from 'zod';
import { email, emptyToUndefined, id, isoDate, phone, timeOfDay } from './common';

/** Customer app (portal) inputs. Customers sign in with a phone OTP scoped to one business. */
const tenantSlug = z.string().trim().min(2).max(64);

export const portalSendOtpSchema = z.object({ tenantSlug, phone });
export const portalVerifyOtpSchema = z.object({ tenantSlug, phone, code: z.string().regex(/^\d{6}$/, 'Enter the 6 digit code') });
export const portalRegisterSchema = z.object({
  signupToken: z.string().min(20),
  name: z.string().trim().min(2).max(120),
  email: emptyToUndefined(email),
  branchId: emptyToUndefined(id),
});
export const portalRefreshSchema = z.object({ refreshToken: z.string().min(20) });

export const portalProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: emptyToUndefined(email).nullable(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  dob: emptyToUndefined(isoDate).nullable(),
  marketingOptIn: z.boolean().optional(),
  whatsappOptIn: z.boolean().optional(),
});

export const portalBranchesQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

export const portalSlotsQuery = z.object({
  branchId: id,
  serviceId: id,
  date: isoDate,
  therapistId: emptyToUndefined(id),
});

export const portalBookingSchema = z.object({
  branchId: id,
  serviceId: id,
  therapistId: emptyToUndefined(id),
  date: isoDate,
  startTime: timeOfDay,
  notes: emptyToUndefined(z.string().trim().max(500)),
});

export const portalAppointmentsQuery = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') });
export const portalCancelSchema = z.object({ reason: emptyToUndefined(z.string().trim().max(300)) });

export const portalPurchaseSchema = z.object({
  itemType: z.enum(['PACKAGE', 'MEMBERSHIP']),
  itemId: id,
  branchId: id,
});

export const portalPaymentVerifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});
