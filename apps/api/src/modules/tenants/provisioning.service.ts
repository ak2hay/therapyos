import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'crypto';
import type { RegisterInput } from '@therapyos/validation';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { DEFAULT_LEDGER_ACCOUNTS } from '../ledger/ledger.accounts';
import { AuditService } from '../../core/audit.service';

export const TRIAL_DAYS = 14;
export const TRIAL_PLAN_CODE = 'BUSINESS';

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

/** Creates a brand-new tenant with owner, system roles, trial subscription and ledger (spec section 56). */
@Injectable()
export class ProvisioningService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  async uniqueSlug(name: string) {
    const base = slugify(name);
    let slug = base;
    while (await this.db.tenant.findUnique({ where: { slug } })) {
      slug = `${base}-${randomBytes(2).toString('hex')}`;
    }
    return slug;
  }

  async provision(input: RegisterInput) {
    const slug = await this.uniqueSlug(input.businessName);
    const passwordHash = await hashPassword(input.password);
    const plan = await this.db.subscriptionPlan.findUnique({ where: { code: TRIAL_PLAN_CODE } });

    const result = await this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.businessName, slug, email: input.email, phone: input.phone, subscriptionPlanId: plan?.id },
      });
      const roles = await this.rbac.createSystemRoles(tenant.id, tx);
      const owner = await tx.user.create({
        data: { tenantId: tenant.id, name: input.ownerName, email: input.email, phone: input.phone, passwordHash },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: owner.id, roleId: roles.OWNER, branchId: null } });
      if (plan) {
        const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
        await tx.tenantSubscription.create({
          data: { tenantId: tenant.id, planId: plan.id, status: 'TRIALING', trialEndDate: trialEnd, renewalDate: trialEnd },
        });
      }
      await tx.ledgerAccount.createMany({ data: DEFAULT_LEDGER_ACCOUNTS.map((a) => ({ ...a, tenantId: tenant.id })) });
      return { tenant, owner };
    });

    await this.audit.log({
      tenantId: result.tenant.id,
      action: 'TENANT_CREATED',
      entityType: 'Tenant',
      entityId: result.tenant.id,
      newValues: { name: input.businessName, slug },
    });
    return result;
  }
}
