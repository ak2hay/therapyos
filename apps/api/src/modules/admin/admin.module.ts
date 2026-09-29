import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  adminCreateTenantSchema,
  adminFeatureFlagSchema,
  adminSubscriptionSchema,
  adminTenantQuery,
  integrationProviderSchema,
  integrationTestSchema,
  platformSettingsSchema,
  subscriptionPlanSchema,
  tenantStatusSchema,
  type AdminCreateTenantInput,
} from '@therapyos/validation';
import { z } from 'zod';
import { PlatformOnly } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { AuthModule } from '../auth/auth.module';
import { IntegrationSettingsService } from '../integration-settings/integration-settings.service';
import { IntegrationSettingsModule } from '../integration-settings/integration-settings.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AdminOnboardingService } from './admin-onboarding.service';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly onboarding: AdminOnboardingService,
    private readonly integrations: IntegrationSettingsService,
  ) {}

  @Get('metrics')
  metrics() {
    return this.admin.metrics();
  }

  @Get('tenants')
  tenants(@Query(Zod(adminTenantQuery)) q: z.infer<typeof adminTenantQuery>) {
    return this.admin.tenants(q);
  }

  /** Manual onboarding: creates the business, its owner login and subscription. */
  @Post('tenants')
  createTenant(@Body(Zod(adminCreateTenantSchema)) body: AdminCreateTenantInput) {
    return this.onboarding.createTenant(body);
  }

  @Get('tenants/:id')
  tenant(@Param('id') id: string) {
    return this.admin.tenant(id);
  }

  @Patch('tenants/:id/status')
  setStatus(@Param('id') id: string, @Body(Zod(tenantStatusSchema)) body: z.infer<typeof tenantStatusSchema>) {
    return this.admin.setStatus(id, body);
  }

  @Patch('tenants/:id/subscription')
  setSubscription(@Param('id') id: string, @Body(Zod(adminSubscriptionSchema)) body: z.infer<typeof adminSubscriptionSchema>) {
    return this.admin.setSubscription(id, body);
  }

  @Post('tenants/:id/owner/invite')
  @HttpCode(200)
  inviteOwner(@Param('id') id: string) {
    return this.onboarding.inviteOwner(id);
  }

  @Post('tenants/:id/owner/reset-password')
  @HttpCode(200)
  resetOwnerPassword(@Param('id') id: string) {
    return this.onboarding.resetOwnerPassword(id);
  }

  @Get('flags')
  flags() {
    return this.admin.flags();
  }

  @Put('flags')
  setFlag(@Body(Zod(adminFeatureFlagSchema)) body: z.infer<typeof adminFeatureFlagSchema>) {
    return this.admin.setFlag(body);
  }

  @Get('plans')
  plans() {
    return this.admin.plans();
  }

  @Post('plans')
  createPlan(@Body(Zod(subscriptionPlanSchema)) body: z.infer<typeof subscriptionPlanSchema>) {
    return this.admin.createPlan(body);
  }

  @Patch('plans/:id')
  updatePlan(@Param('id') id: string, @Body(Zod(subscriptionPlanSchema.partial())) body: Partial<z.infer<typeof subscriptionPlanSchema>>) {
    return this.admin.updatePlan(id, body);
  }

  @Get('integrations')
  listIntegrations() {
    return this.integrations.list(null);
  }

  @Put('integrations/:provider')
  updateIntegration(@Param('provider', Zod(integrationProviderSchema)) provider: z.infer<typeof integrationProviderSchema>, @Body() body: unknown) {
    return this.integrations.update(provider, null, body);
  }

  @Post('integrations/:provider/test')
  @HttpCode(200)
  testIntegration(@Param('provider', Zod(integrationProviderSchema)) provider: z.infer<typeof integrationProviderSchema>, @Body(Zod(integrationTestSchema)) body: z.infer<typeof integrationTestSchema>) {
    return this.integrations.test(provider, null, body.to);
  }

  @Get('platform-settings')
  platformSettings() {
    return this.integrations.platformSettings();
  }

  @Put('platform-settings')
  updatePlatformSettings(@Body(Zod(platformSettingsSchema)) body: z.infer<typeof platformSettingsSchema>) {
    return this.integrations.updatePlatformSettings(body);
  }

  @Get('system')
  system() {
    return this.admin.system();
  }

  @Post('jobs/subscriptions')
  @HttpCode(200)
  runLifecycle() {
    return this.admin.runLifecycle();
  }
}

@Module({
  imports: [SubscriptionModule, TenantsModule, AuthModule, IntegrationSettingsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminOnboardingService],
})
export class AdminModule {}
