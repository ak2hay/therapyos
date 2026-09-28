import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Db, InjectDb } from '../common/prisma/prisma.service';
import { InjectRedis } from '../common/redis/redis.module';

export interface UserAuthz {
  userId: string;
  tenantId: string;
  tenantStatus: string;
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  roles: string[];
  roleNames: string[];
  permissions: string[];
  branchIds: string[];
  allBranches: boolean;
  pv: number;
  therapistId: string | null;
}

const TTL = 300;

@Injectable()
export class AuthzService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private key(userId: string) {
    return `authz:${userId}`;
  }

  async getUserAuthz(userId: string): Promise<UserAuthz | null> {
    const cached = await this.redis.get(this.key(userId));
    if (cached) return JSON.parse(cached) as UserAuthz;
    const authz = await this.load(userId);
    if (authz) await this.redis.set(this.key(userId), JSON.stringify(authz), 'EX', TTL);
    return authz;
  }

  private async load(userId: string): Promise<UserAuthz | null> {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      include: {
        tenant: true,
        therapist: { select: { id: true } },
        userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } },
      },
    });
    if (!user) return null;
    const permissions = new Set<string>();
    const roles = new Set<string>();
    const roleNames = new Set<string>();
    const branchIds = new Set<string>();
    let allBranches = false;
    for (const ur of user.userRoles) {
      roles.add(ur.role.key ?? ur.role.name);
      roleNames.add(ur.role.name);
      for (const rp of ur.role.rolePermissions) permissions.add(rp.permission.code);
      if (ur.branchId) branchIds.add(ur.branchId);
      else allBranches = true;
    }
    if (allBranches) {
      const branches = await this.db.branch.findMany({ where: { tenantId: user.tenantId }, select: { id: true } });
      branches.forEach((b) => branchIds.add(b.id));
    }
    return {
      userId: user.id,
      tenantId: user.tenantId,
      tenantStatus: user.tenant.status,
      tenantName: user.tenant.name,
      tenantSlug: user.tenant.slug,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      roles: [...roles],
      roleNames: [...roleNames],
      permissions: [...permissions],
      branchIds: [...branchIds],
      allBranches,
      pv: user.permissionsVersion,
      therapistId: user.therapist?.id ?? null,
    };
  }

  async invalidateUser(userId: string) {
    await this.redis.del(this.key(userId));
  }

  /** Invalidates the cache for every user in a tenant (e.g. tenant suspended, branch created). */
  async invalidateTenant(tenantId: string) {
    const users = await this.db.user.findMany({ where: { tenantId }, select: { id: true } });
    if (users.length) await this.redis.del(...users.map((u) => this.key(u.id)));
  }

  /** Bumps the permissions version so outstanding access tokens are forced to refresh. */
  async bumpPermissions(userIds: string[]) {
    if (!userIds.length) return;
    await this.db.user.updateMany({ where: { id: { in: userIds } }, data: { permissionsVersion: { increment: 1 } } });
    await this.redis.del(...userIds.map((id) => this.key(id)));
  }
}
