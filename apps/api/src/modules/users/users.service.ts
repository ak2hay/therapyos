import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { StaffInput } from '@therapyos/validation';
import { env } from '../../config/env';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb, Tx } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { pageArgs, paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { ProviderFactory } from '../../integrations/provider.factory';
import { hashPassword } from '../tenants/provisioning.service';
import { sha256, TokenService } from '../auth/token.service';

const INVITE_DAYS = 7;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly features: FeaturesService,
    private readonly providers: ProviderFactory,
    private readonly tokens: TokenService,
  ) {}

  private readonly include = {
    userRoles: { include: { role: { select: { id: true, name: true, key: true } }, branch: { select: { id: true, name: true } } } },
    therapist: { select: { id: true, employeeCode: true } },
  } as const;

  async list(q: { page: number; pageSize: number; search?: string; branchId?: string; status?: string }) {
    const where: Record<string, unknown> = {};
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
      ];
    }
    if (q.status) where.status = q.status;
    if (q.branchId) where.userRoles = { some: { OR: [{ branchId: q.branchId }, { branchId: null }] } };
    const [items, total] = await Promise.all([
      this.db.user.findMany({ where, include: this.include, orderBy: { name: 'asc' }, ...pageArgs(q) }),
      this.db.user.count({ where }),
    ]);
    return paged(items, total, q);
  }

  async get(id: string) {
    const user = await this.db.user.findFirst({ where: { id }, include: this.include });
    if (!user) throw AppError.notFound('Staff member');
    return user;
  }

  /** Prevents privilege escalation: a caller may only grant roles whose permissions they themselves hold. */
  private async assertCanGrant(roleIds: string[]) {
    const granted = RequestContext.get('permissions') ?? new Set<string>();
    const roles = await this.db.role.findMany({
      where: { id: { in: roleIds } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (roles.length !== new Set(roleIds).size) throw AppError.notFound('Role');
    for (const r of roles) {
      const missing = r.rolePermissions.find((rp) => !granted.has(rp.permission.code));
      if (missing) throw AppError.forbidden(`You cannot assign the ${r.name} role.`);
    }
  }

  private async nextEmployeeCode(tx: Tx) {
    const count = await tx.therapist.count();
    return `T${String(count + 1).padStart(3, '0')}`;
  }

  async create(input: StaffInput) {
    const tenantId = RequestContext.requireTenantId();
    if (!input.email && !input.phone) throw AppError.invalidState('Provide an email or phone number.');
    await this.features.assertWithinLimit(tenantId, 'users');
    await this.assertCanGrant(input.roles.map((r) => r.roleId));
    input.roles.forEach((r) => r.branchId && RequestContext.assertBranch(r.branchId));

    const inviteToken = input.sendInvite && input.email && !input.password ? randomBytes(32).toString('base64url') : null;
    const passwordHash = input.password ? await hashPassword(input.password) : null;

    const user = await this.db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          passwordHash,
          status: passwordHash ? 'ACTIVE' : 'INVITED',
          inviteTokenHash: inviteToken ? sha256(inviteToken) : null,
          inviteExpiresAt: inviteToken ? new Date(Date.now() + INVITE_DAYS * 86_400_000) : null,
        },
      });
      await tx.userRole.createMany({
        data: input.roles.map((r) => ({ tenantId, userId: u.id, roleId: r.roleId, branchId: r.branchId ?? null })),
      });
      if (input.isTherapist) {
        await tx.therapist.create({
          data: {
            tenantId,
            userId: u.id,
            name: input.name,
            phone: input.phone,
            employeeCode: await this.nextEmployeeCode(tx),
            primaryBranchId: input.roles.find((r) => r.branchId)?.branchId ?? null,
          },
        });
      }
      return u;
    });

    if (inviteToken && input.email) await this.sendInvite(input.email, input.name, inviteToken);
    await this.audit.log({ action: 'USER_CREATED', entityType: 'User', entityId: user.id, newValues: input });
    return { ...(await this.get(user.id)), inviteLink: inviteToken && env().NODE_ENV !== 'production' ? this.inviteLink(inviteToken) : undefined };
  }

  private inviteLink(token: string) {
    return `${env().APP_URL}/accept-invite?token=${token}`;
  }

  private async sendInvite(email: string, name: string, token: string) {
    const tenantId = RequestContext.requireTenantId();
    const tenantName = (await this.db.tenant.findUnique({ where: { id: tenantId } }))?.name ?? 'TherapyOS';
    const mailer = await this.providers.email(tenantId);
    await mailer.send(
      email,
      `You're invited to ${tenantName} on TherapyOS`,
      `<p>Hi ${name},</p><p>You have been invited to join <b>${tenantName}</b> on TherapyOS.</p>
       <p><a href="${this.inviteLink(token)}">Accept invitation</a> (valid for ${INVITE_DAYS} days)</p>`,
    );
  }

  async resendInvite(id: string) {
    const user = await this.get(id);
    if (user.status !== 'INVITED' || !user.email) throw AppError.invalidState('This user has no pending invitation.');
    const token = randomBytes(32).toString('base64url');
    await this.db.user.update({
      where: { id },
      data: { inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) },
    });
    await this.sendInvite(user.email, user.name, token);
    return { sent: true, inviteLink: env().NODE_ENV !== 'production' ? this.inviteLink(token) : undefined };
  }

  async update(id: string, input: Partial<StaffInput> & { status?: 'ACTIVE' | 'DISABLED' }) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.get(id);
    const isOwner = before.userRoles.some((ur) => ur.role.key === 'OWNER');
    if (isOwner && id !== RequestContext.userId && (input.roles || input.status === 'DISABLED')) {
      throw AppError.forbidden('The business owner can only be modified by themselves.');
    }
    if (id === RequestContext.userId && input.status === 'DISABLED') throw AppError.invalidState('You cannot disable your own account.');
    if (input.roles) {
      await this.assertCanGrant(input.roles.map((r) => r.roleId));
      input.roles.forEach((r) => r.branchId && RequestContext.assertBranch(r.branchId));
      if (isOwner && !input.roles.length) throw AppError.invalidState('The owner must keep at least one role.');
    }

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          status: input.status,
          passwordHash: input.password ? await hashPassword(input.password) : undefined,
        },
      });
      if (input.roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: input.roles.map((r) => ({ tenantId, userId: id, roleId: r.roleId, branchId: r.branchId ?? null })),
        });
      }
      if (input.isTherapist && !before.therapist) {
        await tx.therapist.create({
          data: { tenantId, userId: id, name: input.name ?? before.name, phone: input.phone ?? before.phone, employeeCode: await this.nextEmployeeCode(tx) },
        });
      }
    });

    if (input.roles || input.status) await this.authz.bumpPermissions([id]);
    if (input.status === 'DISABLED') await this.tokens.revokeAllForUser(id);
    await this.audit.log({
      action: input.roles ? 'ROLE_CHANGED' : 'USER_UPDATED',
      entityType: 'User',
      entityId: id,
      oldValues: { name: before.name, status: before.status, roles: before.userRoles.map((r) => r.role.name) },
      newValues: input,
    });
    return this.get(id);
  }
}
