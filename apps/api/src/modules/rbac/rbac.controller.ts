import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@therapyos/types';
import { roleSchema, RoleInput } from '@therapyos/validation';
import { RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { RbacService } from './rbac.service';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller()
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  permissions() {
    return this.rbac.listPermissions();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  list() {
    return this.rbac.listRoles();
  }

  @Post('roles')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  create(@Body(Zod(roleSchema)) body: RoleInput) {
    return this.rbac.createRole(body);
  }

  @Patch('roles/:id')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  update(@Param('id') id: string, @Body(Zod(roleSchema.partial())) body: Partial<RoleInput>) {
    return this.rbac.updateRole(id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  remove(@Param('id') id: string) {
    return this.rbac.deleteRole(id);
  }
}
