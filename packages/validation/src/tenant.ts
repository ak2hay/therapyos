import { z } from 'zod';
import { BUSINESS_TYPES, ALL_PERMISSIONS, FEATURE_FLAG_KEYS } from '@therapyos/types';
import { email, emptyToUndefined, id, phone, recordStatus, timeOfDay, isoDate, percent } from './common';

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: emptyToUndefined(z.string().trim().max(200)),
  logoUrl: emptyToUndefined(z.string().url()),
  phone: emptyToUndefined(phone),
  email: emptyToUndefined(email),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
  country: z.string().length(2).optional(),
  businessType: z.enum(BUSINESS_TYPES as [string, ...string[]]).optional(),
  taxId: emptyToUndefined(z.string().max(30)),
  address: emptyToUndefined(z.string().max(300)),
});
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export const branchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, '2-12 letters/numbers'),
  phone: emptyToUndefined(phone),
  email: emptyToUndefined(email),
  address: emptyToUndefined(z.string().max(300)),
  city: emptyToUndefined(z.string().max(80)),
  state: emptyToUndefined(z.string().max(80)),
  pincode: emptyToUndefined(z.string().max(12)),
  latitude: emptyToUndefined(z.coerce.number().min(-90).max(90)),
  longitude: emptyToUndefined(z.coerce.number().min(-180).max(180)),
  timezone: emptyToUndefined(z.string()),
  openingTime: timeOfDay.default('09:00'),
  closingTime: timeOfDay.default('21:00'),
  status: recordStatus.default('ACTIVE'),
  publicBookingEnabled: z.boolean().default(true),
});
export type BranchInput = z.infer<typeof branchSchema>;

export const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: emptyToUndefined(z.string().max(200)),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).min(1),
});
export type RoleInput = z.infer<typeof roleSchema>;

export const roleAssignmentSchema = z.object({ roleId: id, branchId: z.string().nullable().optional() });

export const staffSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emptyToUndefined(email),
  phone: emptyToUndefined(phone),
  roles: z.array(roleAssignmentSchema).min(1, 'Assign at least one role'),
  sendInvite: z.boolean().default(true),
  password: emptyToUndefined(z.string().min(8)),
  isTherapist: z.boolean().default(false),
});
export type StaffInput = z.infer<typeof staffSchema>;

export const updateStaffSchema = staffSchema.partial().extend({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

export const settingsSchema = z.record(z.string(), z.unknown());

export const featureFlagSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS as [string, ...string[]]),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const taxRateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rate: percent,
  type: z.enum(['GST', 'VAT', 'SALES_TAX', 'OTHER']).default('GST'),
  isInclusive: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  effectiveFrom: isoDate.optional(),
  effectiveTo: emptyToUndefined(isoDate),
  status: recordStatus.default('ACTIVE'),
});
export type TaxRateInput = z.infer<typeof taxRateSchema>;

export const brandingSchema = z.object({
  appName: emptyToUndefined(z.string().max(60)),
  primaryColor: emptyToUndefined(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  accentColor: emptyToUndefined(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  logoUrl: emptyToUndefined(z.string().url()),
  customDomain: emptyToUndefined(
    z
      .string()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
  ),
  emailSenderName: emptyToUndefined(z.string().max(80)),
  emailSenderAddress: emptyToUndefined(email),
  whatsappDisplayName: emptyToUndefined(z.string().max(80)),
  invoiceFooter: emptyToUndefined(z.string().max(500)),
  poweredBy: z.boolean().default(true),
});

export const onboardingSchema = z.object({
  step: z.coerce.number().int().min(1).max(10),
  data: z.record(z.string(), z.unknown()),
});
