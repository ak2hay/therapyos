import { Body, Controller, Get, Global, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { cancelSchema, id, membershipPlanSchema, MembershipPlanInput, paginationQuery, queryBool } from '@therapyos/validation';
import { z } from 'zod';
import { RequireAnyPermission, RequireFeature, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { MembershipsService } from './memberships.service';

const activeQuery = z.object({ active: queryBool });
const membershipsQuery = paginationQuery.extend({
  customerId: z.string().optional(),
  planId: z.string().optional(),
  status: z.string().optional(),
  expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
});
const customerQuery = z.object({ customerId: id });
const autoRenewSchema = z.object({ autoRenew: z.boolean() });

@ApiTags('Memberships')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.MEMBERSHIP_ENABLED)
@Controller('membership-plans')
export class MembershipPlansController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.MEMBERSHIP_READ, PERMISSIONS.POS_USE)
  list(@Query(Zod(activeQuery)) q: z.infer<typeof activeQuery>) {
    return this.memberships.listPlans(q);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.MEMBERSHIP_READ, PERMISSIONS.POS_USE)
  get(@Param('id') id: string) {
    return this.memberships.getPlan(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_MANAGE)
  create(@Body(Zod(membershipPlanSchema)) body: MembershipPlanInput) {
    return this.memberships.createPlan(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_MANAGE)
  update(@Param('id') id: string, @Body(Zod(membershipPlanSchema.partial())) body: Partial<MembershipPlanInput>) {
    return this.memberships.updatePlan(id, body);
  }
}

@ApiTags('Memberships')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.MEMBERSHIP_ENABLED)
@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_READ)
  list(@Query(Zod(membershipsQuery)) q: z.infer<typeof membershipsQuery>) {
    return this.memberships.list(q);
  }

  @Get('active')
  @RequireAnyPermission(PERMISSIONS.MEMBERSHIP_READ, PERMISSIONS.POS_USE, PERMISSIONS.SESSION_MANAGE)
  active(@Query(Zod(customerQuery)) q: z.infer<typeof customerQuery>) {
    return this.memberships.activeFor(q.customerId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_READ)
  get(@Param('id') id: string) {
    return this.memberships.get(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_MANAGE)
  cancel(@Param('id') id: string, @Body(Zod(cancelSchema)) body: z.infer<typeof cancelSchema>) {
    return this.memberships.cancel(id, body.reason);
  }

  @Patch(':id/auto-renew')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_SELL)
  autoRenew(@Param('id') id: string, @Body(Zod(autoRenewSchema)) body: z.infer<typeof autoRenewSchema>) {
    return this.memberships.setAutoRenew(id, body.autoRenew);
  }
}

@Global()
@Module({ controllers: [MembershipPlansController, MembershipsController], providers: [MembershipsService], exports: [MembershipsService] })
export class MembershipsModule {}
