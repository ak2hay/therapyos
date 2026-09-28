import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { branchSchema, BranchInput } from '@therapyos/validation';
import { AllowOnboarding, ApiKeyAllowed, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { BranchesService } from './branches.service';

@ApiTags('Branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @AllowOnboarding()
  @ApiKeyAllowed()
  @RequirePermissions(PERMISSIONS.BRANCH_READ)
  list(@Query('active') active?: string) {
    return this.branches.list(active !== 'true');
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.BRANCH_READ)
  get(@Param('id') id: string) {
    return this.branches.get(id);
  }

  @Post()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  create(@Body(Zod(branchSchema)) body: BranchInput) {
    return this.branches.create(body);
  }

  @Patch(':id')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  update(@Param('id') id: string, @Body(Zod(branchSchema.partial())) body: Partial<BranchInput>) {
    return this.branches.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  remove(@Param('id') id: string) {
    return this.branches.remove(id);
  }
}
