import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ALL_PERMISSIONS, ROLE_TEMPLATES, SystemRole } from '@therapyos/types';
import type { RoleInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';

@Injectable()
export class RbacService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
  ) {}

  async onApplicationBootstrap() {
    await this.syncPermissions();
  }

  /** Ensures every permission code defined in code exists in the database. */
  async syncPermissions() {
    const existing = new Set((await this.db.permission.findMany({ select: { code: true } })).map((p) => p.code));
    const missing = ALL_PERMISSIONS.filter((c) => !existing.has(c));
    if (missing.length) {
      await this.db.permission.createMany({
        data: missing.map((code) => ({ code, module: code.split('.')[0] })),
        skipDuplicates: true,
      });
      this.logger.log(`Synced ${missing.length} permissions`);
    }
  }

  private async permissionIds(codes: string[], client: DbOrTx = this.db) {
    const perms = await client.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
    return perms.map((p) => p.id);
  }

  /** Creates the system role templates for a new tenant (spec section 5 user types). */
  async createSystemRoles(tenantId: string, tx: DbOrTx) {
    const roles: Record<string, string> = {};
    for (const [key, tpl] of Object.entries(ROLE_TEMPLATES)) {
      const ids = await this.permissionIds(tpl.permissions, tx);
      const role = await tx.role.create({
        data: {
          tenantId,
          key,
          name: tpl.name,
          description: tpl.description,
          isSystem: true,
          rolePermissions: { create: ids.map((permissionId) => ({ permissionId })) },
        },
      });
      roles[key] = role.id;
    }
    return roles as Record<SystemRole, string>;
  }

  listPermissions() {
    return this.db.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
  }

  async listRoles() {
    const roles = await this.db.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { rolePermissions: { include: { permission: true } }, _count: { select: { userRoles: true } } },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.userRoles,
      permissions: r.rolePermissions.map((rp) => rp.permission.code),
    }));
  }

  async createRole(input: RoleInput) {
    const tenantId = RequestContext.requireTenantId();
    const ids = await this.permissionIds(input.permissions);
    const role = await this.db.role.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description,
        rolePermissions: { create: ids.map((permissionId) => ({ permissionId })) },
      },
    });
    await this.audit.log({ action: 'ROLE_CREATED', entityType: 'Role', entityId: role.id, newValues: input });
    return role;
  }

  async updateRole(id: string, input: Partial<RoleInput>) {
    const role = await this.db.role.findFirst({ where: { id }, include: { rolePermissions: { include: { permission: true } }, userRoles: true } });
    if (!role) throw AppError.notFound('Role');
    if (role.key === 'OWNER') throw AppError.invalidState('The Owner role cannot be modified.');
    const before = { name: role.name, permissions: role.rolePermissions.map((rp) => rp.permission.code) };

    await this.db.$transaction(async (tx) => {
      await tx.role.update({ where: { id }, data: { name: input.name, description: input.description } });
      if (input.permissions) {
        const ids = await this.permissionIds(input.permissions, tx);
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
      }
    });
    await this.authz.bumpPermissions([...new Set(role.userRoles.map((ur) => ur.userId))]);
    await this.audit.log({ action: 'ROLE_CHANGED', entityType: 'Role', entityId: id, oldValues: before, newValues: input });
    return (await this.listRoles()).find((r) => r.id === id);
  }

  async deleteRole(id: string) {
    const role = await this.db.role.findFirst({ where: { id }, include: { _count: { select: { userRoles: true } } } });
    if (!role) throw AppError.notFound('Role');
    if (role.isSystem) throw AppError.invalidState('System roles cannot be deleted.');
    if (role._count.userRoles > 0) throw AppError.invalidState('Remove this role from all staff before deleting it.');
    await this.db.role.delete({ where: { id } });
    await this.audit.log({ action: 'ROLE_DELETED', entityType: 'Role', entityId: id, oldValues: { name: role.name } });
    return { id };
  }
}
