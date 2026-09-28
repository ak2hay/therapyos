import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import {
  franchiseContractSchema,
  franchiseContractUpdateSchema,
  franchiseeSchema,
  franchiseeUpdateSchema,
  franchiseFeeQuery,
  franchiseFeeStatusSchema,
  franchiseGroupSchema,
  royaltyRunSchema,
} from '@therapyos/validation';
import { z } from 'zod';
import { RequireFeature, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { FranchiseService } from './franchise.service';

@ApiTags('Franchise')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.FRANCHISE)
@Controller('franchise')
export class FranchiseController {
  constructor(private readonly franchise: FranchiseService) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.FRANCHISE_READ)
  overview() {
    return this.franchise.overview();
  }

  @Get('groups')
  @RequirePermissions(PERMISSIONS.FRANCHISE_READ)
  groups() {
    return this.franchise.groups();
  }

  @Post('groups')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  createGroup(@Body(Zod(franchiseGroupSchema)) body: z.infer<typeof franchiseGroupSchema>) {
    return this.franchise.createGroup(body);
  }

  @Patch('groups/:id')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  updateGroup(@Param('id') id: string, @Body(Zod(franchiseGroupSchema.partial())) body: Partial<z.infer<typeof franchiseGroupSchema>>) {
    return this.franchise.updateGroup(id, body);
  }

  @Get('franchisees')
  @RequirePermissions(PERMISSIONS.FRANCHISE_READ)
  list() {
    return this.franchise.list();
  }

  @Get('franchisees/:id')
  @RequirePermissions(PERMISSIONS.FRANCHISE_READ)
  get(@Param('id') id: string) {
    return this.franchise.get(id);
  }

  @Post('franchisees')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  create(@Body(Zod(franchiseeSchema)) body: z.infer<typeof franchiseeSchema>) {
    return this.franchise.create(body);
  }

  @Patch('franchisees/:id')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  update(@Param('id') id: string, @Body(Zod(franchiseeUpdateSchema)) body: z.infer<typeof franchiseeUpdateSchema>) {
    return this.franchise.update(id, body);
  }

  @Post('contracts')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  createContract(@Body(Zod(franchiseContractSchema)) body: z.infer<typeof franchiseContractSchema>) {
    return this.franchise.createContract(body);
  }

  @Patch('contracts/:id')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  updateContract(@Param('id') id: string, @Body(Zod(franchiseContractUpdateSchema)) body: z.infer<typeof franchiseContractUpdateSchema>) {
    return this.franchise.updateContract(id, body);
  }

  @Get('fees')
  @RequirePermissions(PERMISSIONS.FRANCHISE_READ)
  fees(@Query(Zod(franchiseFeeQuery)) q: z.infer<typeof franchiseFeeQuery>) {
    return this.franchise.fees(q);
  }

  @Patch('fees/:id')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  setFeeStatus(@Param('id') id: string, @Body(Zod(franchiseFeeStatusSchema)) body: z.infer<typeof franchiseFeeStatusSchema>) {
    return this.franchise.setFeeStatus(id, body.status);
  }

  @Post('royalties/run')
  @RequirePermissions(PERMISSIONS.FRANCHISE_MANAGE)
  runRoyalties(@Body(Zod(royaltyRunSchema)) body: z.infer<typeof royaltyRunSchema>) {
    return this.franchise.runRoyalties(body.month);
  }
}

@Module({ controllers: [FranchiseController], providers: [FranchiseService], exports: [FranchiseService] })
export class FranchiseModule {}
