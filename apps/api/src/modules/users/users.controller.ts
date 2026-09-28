import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { paginationQuery, staffSchema, StaffInput, updateStaffSchema } from '@therapyos/validation';
import { z } from 'zod';
import { AllowOnboarding, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { UsersService } from './users.service';

const listQuery = paginationQuery.extend({ branchId: z.string().optional(), status: z.string().optional() });

@ApiTags('Staff')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.USER_READ)
  list(@Query(Zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.users.list(q);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USER_READ)
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  create(@Body(Zod(staffSchema)) body: StaffInput) {
    return this.users.create(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  update(@Param('id') id: string, @Body(Zod(updateStaffSchema)) body: z.infer<typeof updateStaffSchema>) {
    return this.users.update(id, body);
  }

  @Post(':id/resend-invite')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  resend(@Param('id') id: string) {
    return this.users.resendInvite(id);
  }
}
