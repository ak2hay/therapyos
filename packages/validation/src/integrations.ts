import { z } from 'zod';
import { INTEGRATION_PROVIDERS, INTEGRATIONS, type IntegrationProviderKey } from '@therapyos/types';
import { email, phone } from './common';

export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS as unknown as [IntegrationProviderKey, ...IntegrationProviderKey[]]);

const fieldValue = z.union([z.string().trim().max(2000), z.number(), z.boolean(), z.null()]);

/** Per-provider body: only that provider's declared fields are accepted; blank secrets keep the stored value. */
export function integrationUpdateSchema(provider: IntegrationProviderKey) {
  const def = INTEGRATIONS[provider];
  const configShape: Record<string, z.ZodTypeAny> = {};
  const secretShape: Record<string, z.ZodTypeAny> = {};
  for (const f of def.fields) {
    if (f.secret) secretShape[f.key] = z.string().trim().max(4000).optional();
    else if (f.type === 'number') configShape[f.key] = z.coerce.number().int().min(1).max(65535).optional().nullable();
    else if (f.type === 'boolean') configShape[f.key] = z.boolean().optional();
    else configShape[f.key] = fieldValue.optional();
  }
  return z.object({
    enabled: z.boolean(),
    config: z.object(configShape).strip().default({}),
    secrets: z.object(secretShape).strip().default({}),
    /** Secret keys to erase. */
    clear: z.array(z.string()).max(10).default([]),
  });
}
export type IntegrationUpdateInput = z.infer<ReturnType<typeof integrationUpdateSchema>>;

export const integrationTestSchema = z.object({
  /** Phone number or email to send a test message to, or a widget access token (optional for credential-only checks). */
  to: z.string().trim().max(4000).optional(),
});

export const platformSettingsSchema = z
  .object({
    platformName: z.string().trim().min(1).max(80),
    supportEmail: z.union([email, z.literal('')]),
    supportPhone: z.string().trim().max(30),
    allowSelfSignup: z.boolean(),
    trialPlanCode: z.string().trim().min(1).max(40),
    trialDays: z.coerce.number().int().min(0).max(365),
    subscriptionGraceDays: z.coerce.number().int().min(0).max(90),
    defaultTimezone: z.string().trim().min(1).max(60),
    defaultCurrency: z.string().trim().length(3).toUpperCase(),
    defaultCountry: z.string().trim().length(2).toUpperCase(),
  })
  .partial();

export const adminCreateTenantSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(120),
    email,
    phone,
    planCode: z.string().trim().min(1).max(40),
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
    subscription: z.enum(['TRIAL', 'ACTIVE']).default('TRIAL'),
    trialDays: z.coerce.number().int().min(1).max(365).optional(),
    /** For ACTIVE subscriptions: the paid-until date (defaults to one billing cycle). */
    activeUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    access: z.enum(['INVITE', 'PASSWORD']).default('INVITE'),
  })
  .strict();
export type AdminCreateTenantInput = z.infer<typeof adminCreateTenantSchema>;

export const planProviderIdsSchema = z
  .object({ MONTHLY: z.string().trim().max(60).optional(), ANNUAL: z.string().trim().max(60).optional() })
  .partial();
