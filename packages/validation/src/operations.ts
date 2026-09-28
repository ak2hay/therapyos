import { z } from 'zod';
import { APPOINTMENT_SOURCES, CUSTOMER_SOURCES } from '@therapyos/types';
import { email, emptyToUndefined, id, isoDate, isoDateTime, paginationQuery, phone, queryBool, timeOfDay } from './common';

export const customerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone,
  email: emptyToUndefined(email),
  dob: emptyToUndefined(isoDate),
  gender: emptyToUndefined(z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'])),
  address: emptyToUndefined(z.string().max(300)),
  city: emptyToUndefined(z.string().max(80)),
  state: emptyToUndefined(z.string().max(80)),
  pincode: emptyToUndefined(z.string().max(12)),
  source: z.enum(CUSTOMER_SOURCES as [string, ...string[]]).default('WALK_IN'),
  primaryBranchId: emptyToUndefined(id),
  notes: emptyToUndefined(z.string().max(2000)),
  tags: z.array(z.string().max(30)).max(20).optional(),
  marketingOptIn: z.boolean().default(false),
  whatsappOptIn: z.boolean().default(true),
  referredById: emptyToUndefined(id),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const updateCustomerSchema = customerSchema.partial().extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
});

export const customerListQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  segment: z.string().optional(),
  source: z.string().optional(),
  status: z.string().optional(),
});

export const appointmentSchema = z.object({
  branchId: id,
  customerId: id,
  serviceId: id,
  therapistId: emptyToUndefined(id),
  date: isoDate,
  startTime: timeOfDay,
  durationMinutes: emptyToUndefined(z.coerce.number().int().min(5).max(600)),
  source: z.enum(APPOINTMENT_SOURCES as [string, ...string[]]).default('RECEPTION'),
  notes: emptyToUndefined(z.string().max(1000)),
});
export type AppointmentInput = z.infer<typeof appointmentSchema>;

export const updateAppointmentSchema = z.object({
  therapistId: emptyToUndefined(id),
  serviceId: emptyToUndefined(id),
  date: emptyToUndefined(isoDate),
  startTime: emptyToUndefined(timeOfDay),
  durationMinutes: emptyToUndefined(z.coerce.number().int().min(5).max(600)),
  status: z.enum(['BOOKED', 'CONFIRMED', 'NO_SHOW']).optional(),
  notes: emptyToUndefined(z.string().max(1000)),
});

export const cancelSchema = z.object({ reason: emptyToUndefined(z.string().max(300)) });

export const appointmentListQuery = z.object({
  branchId: z.string().optional(),
  therapistId: z.string().optional(),
  customerId: z.string().optional(),
  status: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const availabilityQuery = z.object({
  branchId: id,
  serviceId: id,
  date: isoDate,
  therapistId: z.string().optional(),
});

export const queueEntrySchema = z.object({
  branchId: id,
  customerId: emptyToUndefined(id),
  customer: z
    .object({ name: z.string().trim().min(2).max(120), phone })
    .optional(),
  serviceId: emptyToUndefined(id),
  therapistId: emptyToUndefined(id),
  appointmentId: emptyToUndefined(id),
  priority: z.coerce.number().int().min(0).max(10).default(0),
  notes: emptyToUndefined(z.string().max(500)),
});

export const queueAssignSchema = z.object({ therapistId: id, serviceId: emptyToUndefined(id) });

export const sessionSchema = z.object({
  branchId: id,
  customerId: id,
  therapistId: id,
  serviceId: id,
  appointmentId: emptyToUndefined(id),
  queueEntryId: emptyToUndefined(id),
  customerPackageId: emptyToUndefined(id),
  customerMembershipId: emptyToUndefined(id),
  room: emptyToUndefined(z.string().max(40)),
  startNow: z.boolean().default(false),
});

export const completeSessionSchema = z.object({
  notes: emptyToUndefined(z.string().max(4000)),
  customerPackageId: emptyToUndefined(id),
  productsUsed: z.array(z.object({ productId: id, quantity: z.coerce.number().positive() })).optional(),
});

export const sessionNotesSchema = z.object({ notes: z.string().max(4000) });

export const sessionListQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  therapistId: z.string().optional(),
  customerId: z.string().optional(),
  status: z.string().optional(),
  date: isoDate.optional(),
  mine: queryBool,
});

export const publicBookingSchema = z.object({
  serviceId: id,
  therapistId: emptyToUndefined(id),
  date: isoDate,
  startTime: timeOfDay,
  name: z.string().trim().min(2).max(120),
  phone,
  email: emptyToUndefined(email),
  notes: emptyToUndefined(z.string().max(500)),
});

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: emptyToUndefined(z.string().max(2000)),
});

export const manualFeedbackSchema = feedbackSchema.extend({
  branchId: id,
  customerId: emptyToUndefined(id),
  sessionId: emptyToUndefined(id),
  source: z.enum(['IN_APP', 'QR', 'WHATSAPP', 'GOOGLE', 'MANUAL']).default('MANUAL'),
});

export const dateTimeRange = z.object({ from: isoDateTime, to: isoDateTime });
