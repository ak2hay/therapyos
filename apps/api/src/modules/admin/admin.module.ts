import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { adminFeatureFlagSchema, adminSubscriptionSchema, adminTenantQuery, subscriptionPlanSchema, tenantStatusSchema } from '@therapyos/validation';
import { z } from 'zod';
import { PlatformOnly } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('metrics')
  metrics() {
    return this.admin.metrics();
  }

  @Get('tenants')
  tenants(@Query(Zod(adminTenantQuery)) q: z.infer<typeof adminTenantQuery>) {
    return this.admin.tenants(q);
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

@Module({ imports: [SubscriptionModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
