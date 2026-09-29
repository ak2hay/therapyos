import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { BillingCycle } from '@prisma/client';
import { randomBytes } from 'crypto';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { RbacService } from '../rbac/rbac.service';
import { DEFAULT_LEDGER_ACCOUNTS } from '../ledger/ledger.accounts';
import { AuditService } from '../../core/audit.service';
import { PlatformSettingsService } from '../../integrations/platform-settings.service';
import { sha256 } from '../auth/token.service';

export const INVITE_DAYS = 7;

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'business'
  );
}

export const hashPassword = (password: string) => hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export interface ProvisionInput {
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  /** Owner password. Without it the owner is created as INVITED and `inviteToken` must be set. */
  password?: string;
  inviteToken?: string;
}

export interface ProvisionOptions {
  /** Defaults to the platform trial plan. */
  planCode?: string;
  billingCycle?: BillingCycle;
  /** TRIAL (default) starts a free trial; ACTIVE starts a paid-up period recorded as a manual sale. */
  subscription?: 'TRIAL' | 'ACTIVE';
  trialDays?: number;
  activeUntil?: Date;
  /** Who created the business, for the audit trail. */
  createdBy?: 'SELF_SIGNUP' | 'PLATFORM_ADMIN' | 'SEED';
}

/** Creates a brand-new tenant with owner, system roles, subscription and ledger (spec section 56). */
@Injectable()
export class ProvisioningService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
  ) {}

  async uniqueSlug(name: string) {
    const base = slugify(name);
    let slug = base;
    while (await this.db.tenant.findUnique({ where: { slug } })) {
      slug = `${base}-${randomBytes(2).toString('hex')}`;
    }
    return slug;
  }

  async provision(input: ProvisionInput, opts: ProvisionOptions = {}) {
    if (!input.password && !input.inviteToken) throw AppError.validation('Set a password or send an invitation to the owner.');
    const settings = await this.platform.get();
    const slug = await this.uniqueSlug(input.businessName);
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const planCode = opts.planCode ?? settings.trialPlanCode;
    const plan = await this.db.subscriptionPlan.findUnique({ where: { code: planCode } });
    if (opts.planCode && !plan) throw AppError.notFound('Plan');
    const billingCycle = opts.billingCycle ?? 'MONTHLY';
    const now = new Date();

    const result = await this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.businessName,
          slug,
          email: input.email,
          phone: input.phone,
          subscriptionPlanId: plan?.id,
          timezone: settings.defaultTimezone,
          currency: settings.defaultCurrency,
          country: settings.defaultCountry,
        },
      });
      const roles = await this.rbac.createSystemRoles(tenant.id, tx);
      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: input.ownerName,
          email: input.email,
          phone: input.phone,
          passwordHash,
          status: passwordHash ? 'ACTIVE' : 'INVITED',
          inviteTokenHash: !passwordHash && input.inviteToken ? sha256(input.inviteToken) : null,
          inviteExpiresAt: !passwordHash && input.inviteToken ? new Date(now.getTime() + INVITE_DAYS * 86_400_000) : null,
        },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: owner.id, roleId: roles.OWNER, branchId: null } });
      if (plan) {
        if (opts.subscription === 'ACTIVE') {
          const renewal = opts.activeUntil ?? new Date(now.getTime() + (billingCycle === 'ANNUAL' ? 365 : 30) * 86_400_000);
          await tx.tenantSubscription.create({
            data: { tenantId: tenant.id, planId: plan.id, billingCycle, status: 'ACTIVE', startDate: now, renewalDate: renewal, provider: 'manual' },
          });
        } else {
          const trialEnd = new Date(now.getTime() + (opts.trialDays ?? settings.trialDays) * 86_400_000);
          await tx.tenantSubscription.create({
            data: { tenantId: tenant.id, planId: plan.id, billingCycle, status: 'TRIALING', trialEndDate: trialEnd, renewalDate: trialEnd },
          });
        }
      }
      await tx.ledgerAccount.createMany({ data: DEFAULT_LEDGER_ACCOUNTS.map((a) => ({ ...a, tenantId: tenant.id })) });
      return { tenant, owner };
    });

    await this.audit.log({
      tenantId: result.tenant.id,
      action: 'TENANT_CREATED',
      entityType: 'Tenant',
      entityId: result.tenant.id,
      newValues: { name: input.businessName, slug, plan: plan?.code ?? null, subscription: opts.subscription ?? 'TRIAL', createdBy: opts.createdBy ?? 'SELF_SIGNUP' },
    });
    return result;
  }
}
