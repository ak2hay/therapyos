import { z } from 'zod';
import { emptyToUndefined, id, isoDate, money, percent, phone, recordStatus, timeOfDay } from './common';

export const serviceCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: emptyToUndefined(z.string().max(300)),
  sortOrder: z.coerce.number().int().default(0),
  status: recordStatus.default('ACTIVE'),
});

export const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: emptyToUndefined(z.string().max(1000)),
  categoryId: emptyToUndefined(id),
  durationMinutes: z.coerce.number().int().min(5).max(600),
  basePrice: money,
  taxRate: percent.default(0),
  color: emptyToUndefined(z.string().max(20)),
  status: recordStatus.default('ACTIVE'),
  consumables: z
    .array(z.object({ productId: id, quantity: z.coerce.number().positive() }))
    .optional(),
});
export type ServiceInput = z.infer<typeof serviceSchema>;

export const branchServiceSchema = z.object({
  branchId: id,
  price: emptyToUndefined(money),
  durationMinutes: emptyToUndefined(z.coerce.number().int().min(5).max(600)),
  isActive: z.boolean().default(true),
});

export const commissionTier = z.object({ minSessions: z.coerce.number().int().min(0), value: z.coerce.number().min(0) });

export const therapistSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: emptyToUndefined(phone),
  userId: emptyToUndefined(id),
  employeeCode: emptyToUndefined(z.string().trim().max(20)),
  specialization: emptyToUndefined(z.string().max(200)),
  joiningDate: emptyToUndefined(isoDate),
  primaryBranchId: emptyToUndefined(id),
  status: recordStatus.default('ACTIVE'),
  commissionType: z.enum(['PERCENTAGE', 'FIXED_PER_SESSION', 'TIERED', 'NONE']).default('NONE'),
  commissionValue: z.coerce.number().min(0).default(0),
  commissionTiers: z.array(commissionTier).optional(),
  color: emptyToUndefined(z.string().max(20)),
  serviceIds: z.array(id).optional(),
});
export type TherapistInput = z.infer<typeof therapistSchema>;

export const scheduleSchema = z.object({
  schedules: z.array(
    z
      .object({
        branchId: id,
        dayOfWeek: z.coerce.number().int().min(0).max(6),
        startTime: timeOfDay,
        endTime: timeOfDay,
      })
      .refine((s) => s.startTime < s.endTime, 'End time must be after start time'),
  ),
});

export const scheduleExceptionSchema = z.object({
  date: isoDate,
  type: z.enum(['LEAVE', 'HOLIDAY', 'SPECIAL_SHIFT', 'UNAVAILABLE']),
  reason: emptyToUndefined(z.string().max(200)),
  startTime: emptyToUndefined(timeOfDay),
  endTime: emptyToUndefined(timeOfDay),
  branchId: emptyToUndefined(id),
});

export const productCategorySchema = z.object({ name: z.string().trim().min(1).max(80) });

export const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sku: z.string().trim().min(1).max(40),
  categoryId: emptyToUndefined(id),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  costPrice: money.default(0),
  sellingPrice: money.default(0),
  taxRate: percent.default(0),
  isRetail: z.boolean().default(true),
  isConsumable: z.boolean().default(false),
  barcode: emptyToUndefined(z.string().max(40)),
  imageUrl: emptyToUndefined(z.string().url()),
  status: recordStatus.default('ACTIVE'),
});
export type ProductInput = z.infer<typeof productSchema>;
