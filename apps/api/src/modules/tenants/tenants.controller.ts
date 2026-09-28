import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { updateTenantSchema, UpdateTenantInput } from '@therapyos/validation';
import { AllowOnboarding, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AuditService } from '../../core/audit.service';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { AuthzService } from '../../core/authz.service';

@ApiTags('Tenant')
@ApiBearerAuth()
@Controller('tenant')
export class TenantsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly features: FeaturesService,
    private readonly settings: SettingsService,
    private readonly authz: AuthzService,
  ) {}

  @Get()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  async get() {
    const id = RequestContext.requireTenantId();
    const [tenant, branding, subscription] = await Promise.all([
      this.db.tenant.findUniqueOrThrow({ where: { id } }),
      this.db.tenantBranding.findUnique({ where: { tenantId: id } }),
      this.db.tenantSubscription.findFirst({ where: { tenantId: id, isCurrent: true }, include: { plan: true } }),
    ]);
    return { ...tenant, branding, subscription };
  }

  @Patch()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_UPDATE)
  async update(@Body(Zod(updateTenantSchema)) body: UpdateTenantInput) {
    const id = RequestContext.requireTenantId();
    const before = await this.db.tenant.findUniqueOrThrow({ where: { id } });
    const tenant = await this.db.tenant.update({ where: { id }, data: body as never });
    await this.settings.invalidate(id);
    await this.authz.invalidateTenant(id);
    await this.audit.log({ action: 'TENANT_UPDATED', entityType: 'Tenant', entityId: id, oldValues: before, newValues: body });
    return tenant;
  }

  @Get('usage')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  async usage() {
    const id = RequestContext.requireTenantId();
    const [limits, usage, features] = await Promise.all([
      this.features.getLimits(id),
      this.features.getUsage(id),
      this.features.getFeatures(id),
    ]);
    return { limits, usage, features };
  }
}
