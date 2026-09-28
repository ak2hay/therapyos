import { z } from 'zod';
import { CUSTOMER_SEGMENTS, NOTIFICATION_EVENTS } from '@therapyos/types';
import { email, emptyToUndefined, id, isoDate, isoDateTime, money, paginationQuery, percent, phone, recordStatus } from './common';

const channel = z.enum(['PUSH', 'SMS', 'EMAIL', 'WHATSAPP', 'IN_APP']);

export const notificationTemplateSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS as [string, ...string[]]),
  channel,
  name: z.string().trim().min(2).max(120),
  subject: emptyToUndefined(z.string().max(200)),
  body: z.string().min(1).max(4000),
  whatsappTemplateName: emptyToUndefined(z.string().max(120)),
  language: z.string().max(10).default('en'),
  isActive: z.boolean().default(true),
});

export const notificationPreferenceSchema = z.object({
  preferences: z.array(z.object({ event: z.string(), channel, enabled: z.boolean() })),
});

export const campaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  segment: emptyToUndefined(z.enum(CUSTOMER_SEGMENTS as [string, ...string[]])),
  filters: z
    .object({
      branchId: z.string().optional(),
      birthdayThisMonth: z.boolean().optional(),
      packageExpiringInDays: z.coerce.number().int().optional(),
      membershipExpiringInDays: z.coerce.number().int().optional(),
      firstTimeVisitors: z.boolean().optional(),
      minLifetimeValue: z.coerce.number().optional(),
    })
    .default({}),
  channel: z.enum(['SMS', 'EMAIL', 'WHATSAPP']),
  subject: emptyToUndefined(z.string().max(200)),
  templateBody: z.string().min(1).max(4000),
  offerId: emptyToUndefined(id),
  couponId: emptyToUndefined(id),
  scheduledAt: emptyToUndefined(isoDateTime),
});
export type CampaignInput = z.infer<typeof campaignSchema>;

export const campaignAudienceSchema = campaignSchema.pick({ segment: true, filters: true, channel: true });
export type CampaignAudienceInput = z.infer<typeof campaignAudienceSchema>;

export const campaignQuery = paginationQuery.extend({
  status: z.string().optional(),
});

export const campaignScheduleSchema = z.object({ scheduledAt: emptyToUndefined(isoDateTime) });

export const notificationLogQuery = paginationQuery.extend({
  channel: channel.optional(),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED']).optional(),
  event: z.string().max(60).optional(),
  customerId: z.string().optional(),
  campaignId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const templatePreviewSchema = z.object({
  event: z.string().max(60).optional(),
  subject: emptyToUndefined(z.string().max(200)),
  body: z.string().min(1).max(4000),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const testNotificationSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS as [string, ...string[]]),
  channel: z.enum(['SMS', 'EMAIL', 'WHATSAPP']),
  to: z.string().trim().min(3).max(200),
});

export const feedbackQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  therapistId: z.string().optional(),
  source: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  maxRating: z.coerce.number().int().min(1).max(5).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const publicBranchFeedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: emptyToUndefined(z.string().max(2000)),
  name: emptyToUndefined(z.string().trim().max(120)),
  phone: emptyToUndefined(phone),
});

export const retentionCustomersQuery = paginationQuery.extend({
  segment: z.enum(CUSTOMER_SEGMENTS as [string, ...string[]]).optional(),
  branchId: z.string().optional(),
});

export const retentionOverviewQuery = z.object({ branchId: z.string().optional() });

export const franchiseGroupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: emptyToUndefined(z.string().max(500)),
  status: recordStatus.default('ACTIVE'),
});

export const franchiseeSchema = z.object({
  franchiseGroupId: id,
  name: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: emptyToUndefined(email),
  phone: emptyToUndefined(phone),
  userId: emptyToUndefined(id),
  status: recordStatus.default('ACTIVE'),
  branchIds: z.array(id).default([]),
});

export const franchiseContractSchema = z.object({
  franchiseeId: id,
  startDate: isoDate,
  endDate: emptyToUndefined(isoDate),
  royaltyPercent: percent.default(0),
  marketingFeePercent: percent.default(0),
  fixedMonthlyFee: money.default(0),
  franchiseFee: money.default(0),
  terms: emptyToUndefined(z.string().max(5000)),
  status: z.enum(['DRAFT', 'ACTIVE', 'TERMINATED', 'EXPIRED']).default('ACTIVE'),
});

export const subscriptionPlanSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(30),
  name: z.string().trim().min(2).max(60),
  description: emptyToUndefined(z.string().max(500)),
  monthlyPrice: money,
  annualPrice: money,
  maxBranches: z.coerce.number().int().min(1),
  maxUsers: z.coerce.number().int().min(1),
  maxCustomers: z.coerce.number().int().min(1),
  features: z.array(z.string()).default([]),
  status: recordStatus.default('ACTIVE'),
  sortOrder: z.coerce.number().int().default(0),
});

export const changePlanSchema = z.object({
  planId: id,
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
});

export const supportTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(5000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

export const supportMessageSchema = z.object({ body: z.string().trim().min(1).max(5000) });

export const supportTicketUpdateSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assignedToAdminId: emptyToUndefined(id),
});

export const apiKeySchema = z.object({
  name: z.string().trim().min(2).max(60),
  scopes: z.array(z.string()).min(1),
});

export const aiQuestionSchema = z.object({
  question: z.string().trim().min(3).max(500),
  from: emptyToUndefined(isoDate),
  to: emptyToUndefined(isoDate),
  branchId: emptyToUndefined(id),
});

export const tenantStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']),
  reason: emptyToUndefined(z.string().max(300)),
});

export const hqQuery = z.object({
  from: isoDate,
  to: isoDate,
});

export const franchiseeUpdateSchema = franchiseeSchema.partial();
export const franchiseContractUpdateSchema = franchiseContractSchema.omit({ franchiseeId: true }).partial();

export const franchiseFeeQuery = paginationQuery.extend({
  franchiseeId: z.string().optional(),
  status: z.enum(['DUE', 'PAID', 'WAIVED']).optional(),
  type: z.enum(['ROYALTY', 'MARKETING', 'FIXED', 'FRANCHISE_FEE']).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export const franchiseFeeStatusSchema = z.object({ status: z.enum(['DUE', 'PAID', 'WAIVED']) });

export const royaltyRunSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM') });

export const supportTicketQuery = paginationQuery.extend({
  status: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  tenantId: z.string().optional(),
});

export const adminTenantQuery = paginationQuery.extend({
  status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
  planId: z.string().optional(),
  subscriptionStatus: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).optional(),
});

export const adminSubscriptionSchema = z.object({
  planId: emptyToUndefined(id),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).optional(),
  trialEndDate: emptyToUndefined(isoDate),
  renewalDate: emptyToUndefined(isoDate),
});

export const adminFeatureFlagSchema = z.object({
  key: z.string().min(2).max(60),
  enabled: z.boolean().nullable(),
  tenantId: emptyToUndefined(id),
});

export const publicSlotsQuery = z.object({
  branchId: z.string().min(1),
  serviceId: z.string().min(1),
  date: isoDate,
  therapistId: z.string().optional(),
});
