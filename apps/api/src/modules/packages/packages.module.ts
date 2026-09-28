import { Body, Controller, Get, Global, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { id, packageSchema, PackageInput, paginationQuery, queryBool, redeemPackageSchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequireAnyPermission, RequireFeature, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { PackagesService } from './packages.service';

const activeQuery = z.object({ active: queryBool });
const customerPackagesQuery = paginationQuery.extend({
  customerId: z.string().optional(),
  status: z.string().optional(),
  expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
});
const eligibleQuery = z.object({ customerId: id, serviceId: z.string().optional() });
const reverseSchema = z.object({ reason: z.string().trim().min(3).max(300) });

@ApiTags('Packages')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.PACKAGES_ENABLED)
@Controller('packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.PACKAGE_READ, PERMISSIONS.POS_USE)
  list(@Query(Zod(activeQuery)) q: z.infer<typeof activeQuery>) {
    return this.packages.list(q);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.PACKAGE_READ, PERMISSIONS.POS_USE)
  get(@Param('id') id: string) {
    return this.packages.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PACKAGE_MANAGE)
  create(@Body(Zod(packageSchema)) body: PackageInput) {
    return this.packages.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PACKAGE_MANAGE)
  update(@Param('id') id: string, @Body(Zod(packageSchema.partial())) body: Partial<PackageInput>) {
    return this.packages.update(id, body);
  }
}

@ApiTags('Packages')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.PACKAGES_ENABLED)
@Controller('customer-packages')
export class CustomerPackagesController {
  constructor(private readonly packages: PackagesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PACKAGE_READ)
  list(@Query(Zod(customerPackagesQuery)) q: z.infer<typeof customerPackagesQuery>) {
    return this.packages.listCustomerPackages(q);
  }

  @Get('eligible')
  @RequireAnyPermission(PERMISSIONS.PACKAGE_READ, PERMISSIONS.SESSION_MANAGE, PERMISSIONS.POS_USE)
  eligible(@Query(Zod(eligibleQuery)) q: z.infer<typeof eligibleQuery>) {
    return this.packages.eligible(q.customerId, q.serviceId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PACKAGE_READ)
  get(@Param('id') id: string) {
    return this.packages.getCustomerPackage(id);
  }

  @Post(':id/redeem')
  @RequirePermissions(PERMISSIONS.PACKAGE_REDEEM)
  async redeem(@Param('id') id: string, @Body(Zod(redeemPackageSchema)) body: z.infer<typeof redeemPackageSchema>) {
    await this.packages.redeem({ customerPackageId: id, serviceId: body.serviceId, quantity: body.quantity, sessionId: body.sessionId, branchId: body.branchId });
    return this.packages.getCustomerPackage(id);
  }

  @Post('redemptions/:redemptionId/reverse')
  @RequirePermissions(PERMISSIONS.PACKAGE_MANAGE)
  reverse(@Param('redemptionId') redemptionId: string, @Body(Zod(reverseSchema)) body: z.infer<typeof reverseSchema>) {
    return this.packages.reverse(redemptionId, body.reason);
  }
}

@Global()
@Module({ controllers: [PackagesController, CustomerPackagesController], providers: [PackagesService], exports: [PackagesService] })
export class PackagesModule {}
