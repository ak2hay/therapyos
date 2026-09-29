import { Injectable } from '@nestjs/common';
import type { IntegrationProviderKey, PlatformSettings } from '@therapyos/types';
import { integrationUpdateSchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { ZodPipe } from '../../common/pipes/zod.pipe';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit.service';
import { IntegrationsConfigService } from '../../integrations/integrations-config.service';
import { PlatformSettingsService } from '../../integrations/platform-settings.service';
import { ProviderFactory } from '../../integrations/provider.factory';

/**
 * Settings screens for integration credentials (super admin: platform keys; business owners: their
 * own keys) and platform settings. Secret values never leave the server and never reach the audit log.
 */
@Injectable()
export class IntegrationSettingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly config: IntegrationsConfigService,
    private readonly providers: ProviderFactory,
    private readonly platform: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  private actor() {
    return RequestContext.get('platformAdminId') ?? RequestContext.userId ?? undefined;
  }

  async list(tenantId: string | null) {
    return {
      items: await this.config.list(tenantId),
      webhookUrls: {
        payments: `${env().API_URL}/api/v1/webhooks/razorpay`,
        ...(tenantId ? {} : { subscriptions: `${env().API_URL}/api/v1/webhooks/razorpay/subscriptions` }),
      },
    };
  }

  async update(provider: IntegrationProviderKey, tenantId: string | null, body: unknown) {
    const input = new ZodPipe(integrationUpdateSchema(provider)).transform(body);
    const { view, changed } = await this.config.update(provider, tenantId, input, this.actor());
    await this.audit.log({
      tenantId,
      action: 'INTEGRATION_UPDATED',
      entityType: 'IntegrationConfig',
      entityId: provider,
      newValues: { provider, scope: tenantId ? 'tenant' : 'platform', ...changed },
    });
    return view;
  }

  async test(provider: IntegrationProviderKey, tenantId: string | null, to?: string) {
    const result = await this.providers.test(provider, tenantId, to);
    await this.audit.log({ tenantId, action: 'INTEGRATION_TESTED', entityType: 'IntegrationConfig', entityId: provider, newValues: { provider, ok: result.ok } });
    return result;
  }

  platformSettings() {
    return this.platform.get();
  }

  async updatePlatformSettings(input: Partial<PlatformSettings>) {
    if (input.trialPlanCode && !(await this.db.subscriptionPlan.findUnique({ where: { code: input.trialPlanCode }, select: { id: true } }))) {
      throw AppError.validation(`There is no plan with code ${input.trialPlanCode}.`, { fields: { trialPlanCode: 'Unknown plan' } });
    }
    const before = await this.platform.get();
    const after = await this.platform.update(input);
    await this.audit.log({ action: 'PLATFORM_SETTINGS_UPDATED', entityType: 'PlatformSetting', oldValues: pick(before, Object.keys(input)), newValues: input });
    return after;
  }
}

function pick<T extends object>(obj: T, keys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
}
