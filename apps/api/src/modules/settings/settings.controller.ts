import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@therapyos/types';
import { featureFlagSchema, paginationQuery, settingsSchema, taxRateSchema, TaxRateInput } from '@therapyos/validation';
import { z } from 'zod';
import { AllowOnboarding, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { dateOnly } from '../../common/utils/dates';
import { pageArgs, paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';

@ApiTags('Settings')
@ApiBearerAuth()
@Controller()
export class SettingsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly features: FeaturesService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  getSettings() {
    return this.settings.getAll(RequestContext.requireTenantId());
  }

  @Patch('settings')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async updateSettings(@Body(Zod(settingsSchema)) body: Record<string, unknown>) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.settings.getAll(tenantId);
    const result = await this.settings.setMany(tenantId, body);
    await this.audit.log({ action: 'SETTINGS_UPDATED', entityType: 'TenantSetting', oldValues: before, newValues: body });
    return result;
  }

  @Get('features')
  @AllowOnboarding()
  async getFeatures() {
    const tenantId = RequestContext.requireTenantId();
    const [effective, overrides, limits] = await Promise.all([
      this.features.getFeatures(tenantId),
      this.db.featureFlag.findMany({ where: { tenantId } }),
      this.features.getLimits(tenantId),
    ]);
    return { effective, overrides, plan: limits.planCode };
  }

  /** Tenants may switch off features, but can only switch on features that their plan includes. */
  @Put('feature-flags')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async setFlag(@Body(Zod(featureFlagSchema)) body: z.infer<typeof featureFlagSchema>) {
    const tenantId = RequestContext.requireTenantId();
    if (body.enabled) {
      const sub = await this.db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: true }, include: { plan: true } });
      if (!sub?.plan.features.includes(body.key)) {
        throw AppError.forbidden('This feature is not included in your plan. Upgrade to enable it.');
      }
    }
    const flag = await this.db.featureFlag.upsert({
      where: { tenantId_key: { tenantId, key: body.key } },
      create: { tenantId, key: body.key, enabled: body.enabled, config: body.config as Prisma.InputJsonValue },
      update: { enabled: body.enabled, config: body.config as Prisma.InputJsonValue },
    });
    await this.features.invalidate(tenantId);
    await this.audit.log({ action: 'FEATURE_FLAG_CHANGED', entityType: 'FeatureFlag', entityId: flag.id, newValues: body });
    return flag;
  }

  @Get('tax-rates')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  listTaxRates() {
    return this.db.taxRate.findMany({ orderBy: [{ isDefault: 'desc' }, { rate: 'asc' }] });
  }

  private taxData(input: Partial<TaxRateInput>) {
    return {
      ...input,
      effectiveFrom: input.effectiveFrom ? dateOnly(input.effectiveFrom) : undefined,
      effectiveTo: input.effectiveTo ? dateOnly(input.effectiveTo) : undefined,
    };
  }

  @Post('tax-rates')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async createTaxRate(@Body(Zod(taxRateSchema)) body: TaxRateInput) {
    const tenantId = RequestContext.requireTenantId();
    if (body.isDefault) await this.db.taxRate.updateMany({ where: {}, data: { isDefault: false } });
    const rate = await this.db.taxRate.create({ data: { ...this.taxData(body), tenantId } as never });
    await this.audit.log({ action: 'TAX_RATE_CREATED', entityType: 'TaxRate', entityId: rate.id, newValues: body });
    return rate;
  }

  @Patch('tax-rates/:id')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async updateTaxRate(@Param('id') id: string, @Body(Zod(taxRateSchema.partial())) body: Partial<TaxRateInput>) {
    const before = await this.db.taxRate.findFirst({ where: { id } });
    if (!before) throw AppError.notFound('Tax rate');
    if (body.isDefault) await this.db.taxRate.updateMany({ where: {}, data: { isDefault: false } });
    const rate = await this.db.taxRate.update({ where: { id }, data: this.taxData(body) as never });
    await this.audit.log({ action: 'TAX_RATE_UPDATED', entityType: 'TaxRate', entityId: id, oldValues: before, newValues: body });
    return rate;
  }

  @Delete('tax-rates/:id')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async deleteTaxRate(@Param('id') id: string) {
    const rate = await this.db.taxRate.update({ where: { id }, data: { status: 'INACTIVE', isDefault: false } });
    await this.audit.log({ action: 'TAX_RATE_DEACTIVATED', entityType: 'TaxRate', entityId: id });
    return rate;
  }
}

const auditQuery = paginationQuery.extend({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  userId: z.string().optional(),
});

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  async list(@Query(Zod(auditQuery)) q: z.infer<typeof auditQuery>) {
    const where: Record<string, unknown> = {};
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = q.userId;
    if (q.search) where.action = { contains: q.search.toUpperCase() };
    const [items, total] = await Promise.all([
      this.db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.db.auditLog.count({ where }),
    ]);
    const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
    const users = await this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return paged(items.map((i) => ({ ...i, userName: i.userId ? names.get(i.userId) ?? null : null })), total, q);
  }
}
