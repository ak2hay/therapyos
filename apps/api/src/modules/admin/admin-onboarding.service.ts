import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { AdminCreateTenantInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit.service';
import { PlatformSettingsService } from '../../integrations/platform-settings.service';
import { ProviderFactory } from '../../integrations/provider.factory';
import { sha256, TokenService } from '../auth/token.service';
import { hashPassword, INVITE_DAYS, ProvisioningService } from '../tenants/provisioning.service';

/** Readable one-time password: no ambiguous characters, always meets the password policy. */
export function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `Rk-${out}9a`;
}

/** Super-admin onboarding: creates businesses on behalf of clients and manages their owner's access. */
@Injectable()
export class AdminOnboardingService {
  private readonly logger = new Logger(AdminOnboardingService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly provisioning: ProvisioningService,
    private readonly providers: ProviderFactory,
    private readonly platform: PlatformSettingsService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  private loginUrl() {
    return `${env().APP_URL}/login`;
  }

  private inviteLink(token: string) {
    return `${env().APP_URL}/accept-invite?token=${token}`;
  }

  /** Emails the invitation; failures are logged because the admin also gets the link to share by hand. */
  private async emailInvite(tenantId: string, to: string, ownerName: string, businessName: string, token: string) {
    const { platformName } = await this.platform.get();
    try {
      const mailer = await this.providers.email(tenantId);
      const res = await mailer.send(
        to,
        `Your ${businessName} account on ${platformName} is ready`,
        `<p>Hi ${ownerName},</p><p>We have set up <b>${businessName}</b> on ${platformName}. Set your password to sign in and finish the setup.</p>
         <p><a href="${this.inviteLink(token)}">Set your password</a> (valid for ${INVITE_DAYS} days)</p>`,
      );
      return res.status === 'SENT';
    } catch (e) {
      this.logger.warn(`Owner invite email to ${to} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async createTenant(input: AdminCreateTenantInput) {
    const exists = await this.db.user.findFirst({ where: { OR: [{ email: input.email }, { phone: input.phone }] }, select: { id: true } });
    if (exists) throw AppError.conflict('A user with this email or phone already exists.', ErrorCode.DUPLICATE);
    const plan = await this.db.subscriptionPlan.findUnique({ where: { code: input.planCode } });
    if (!plan) throw AppError.notFound('Plan');
    const activeUntil = input.activeUntil ? dateOnly(input.activeUntil) : undefined;
    if (activeUntil && activeUntil.getTime() <= Date.now()) throw AppError.validation('The paid-until date must be in the future.');

    const password = input.access === 'PASSWORD' ? tempPassword() : undefined;
    const inviteToken = input.access === 'INVITE' ? randomBytes(32).toString('base64url') : undefined;
    const { tenant, owner } = await this.provisioning.provision(
      { businessName: input.businessName, ownerName: input.ownerName, email: input.email, phone: input.phone, password, inviteToken },
      { planCode: plan.code, billingCycle: input.billingCycle, subscription: input.subscription, trialDays: input.trialDays, activeUntil, createdBy: 'PLATFORM_ADMIN' },
    );
    const emailed = inviteToken ? await this.emailInvite(tenant.id, input.email, input.ownerName, input.businessName, inviteToken) : false;
    await this.audit.log({
      tenantId: tenant.id,
      action: 'TENANT_CREATED_BY_ADMIN',
      entityType: 'Tenant',
      entityId: tenant.id,
      newValues: { businessName: input.businessName, ownerEmail: input.email, plan: plan.code, subscription: input.subscription, billingCycle: input.billingCycle, access: input.access, adminId: RequestContext.get('platformAdminId') ?? null },
    });
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      ownerId: owner.id,
      loginUrl: this.loginUrl(),
      loginEmail: input.email,
      temporaryPassword: password ?? null,
      inviteLink: inviteToken ? this.inviteLink(inviteToken) : null,
      inviteEmailed: emailed,
    };
  }

  private async owner(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) throw AppError.notFound('Tenant');
    const owner = await this.db.user.findFirst({
      where: { tenantId, userRoles: { some: { role: { key: 'OWNER' } } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!owner) throw AppError.notFound('Owner');
    return { tenant, owner };
  }

  /** New invitation link for an owner who has not signed in yet (the previous link stops working). */
  async inviteOwner(tenantId: string) {
    const { tenant, owner } = await this.owner(tenantId);
    if (owner.status !== 'INVITED') throw AppError.invalidState('The owner has already set a password. Use reset password instead.');
    if (!owner.email) throw AppError.invalidState('The owner has no email address.');
    const token = randomBytes(32).toString('base64url');
    await this.db.user.update({ where: { id: owner.id }, data: { inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) } });
    const emailed = await this.emailInvite(tenantId, owner.email, owner.name, tenant.name, token);
    await this.audit.log({ tenantId, action: 'OWNER_INVITE_RESENT', entityType: 'User', entityId: owner.id });
    return { inviteLink: this.inviteLink(token), inviteEmailed: emailed, loginEmail: owner.email };
  }

  /** Sets a one-time password, activates the account and signs the owner out everywhere. */
  async resetOwnerPassword(tenantId: string) {
    const { owner } = await this.owner(tenantId);
    const password = tempPassword();
    await this.db.user.update({
      where: { id: owner.id },
      data: { passwordHash: await hashPassword(password), status: owner.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE', inviteTokenHash: null, inviteExpiresAt: null },
    });
    await this.tokens.revokeAllForUser(owner.id);
    await this.audit.log({ tenantId, action: 'OWNER_PASSWORD_RESET', entityType: 'User', entityId: owner.id });
    return { temporaryPassword: password, loginEmail: owner.email ?? owner.phone, loginUrl: this.loginUrl() };
  }
}
