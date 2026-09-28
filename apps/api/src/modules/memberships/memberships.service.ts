import { Injectable } from '@nestjs/common';
import { CustomerMembershipStatus, Prisma } from '@prisma/client';
import { MembershipPlanInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { addDays, dateOnly } from '../../common/utils/dates';
import { num } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { maskContact } from '../customers/customers.service';

const membershipInclude = {
  plan: { include: { benefits: true } },
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } },
  usages: { select: { benefitId: true, quantity: true } },
} satisfies Prisma.CustomerMembershipInclude;

type MembershipRow = Prisma.CustomerMembershipGetPayload<{ include: typeof membershipInclude }>;

export interface ActiveBenefit {
  membershipId: string;
  membershipName: string;
  benefitId: string;
  type: 'SERVICE_DISCOUNT_PERCENT' | 'PRODUCT_DISCOUNT_PERCENT' | 'INCLUDED_SESSIONS' | 'PRIORITY_BOOKING';
  serviceId: string | null;
  categoryId: string | null;
  value: number;
  quantity: number | null;
  remaining: number | null;
}

@Injectable()
export class MembershipsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
  ) {}

  // ---------- plans ----------

  async listPlans(q: { active?: boolean }) {
    const rows = await this.db.membershipPlan.findMany({
      where: q.active ? { status: 'ACTIVE' } : {},
      include: { benefits: true, _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } },
      orderBy: { price: 'asc' },
    });
    return rows.map(({ _count, ...p }) => ({ ...p, activeMembers: _count.memberships }));
  }

  async getPlan(id: string) {
    const p = await this.db.membershipPlan.findFirst({ where: { id }, include: { benefits: true } });
    if (!p) throw AppError.notFound('Membership plan');
    return p;
  }

  private validateBenefits(benefits: MembershipPlanInput['benefits']) {
    for (const b of benefits) {
      if (b.type === 'INCLUDED_SESSIONS' && !b.quantity) throw AppError.validation('Included sessions need a quantity.');
      if ((b.type === 'SERVICE_DISCOUNT_PERCENT' || b.type === 'PRODUCT_DISCOUNT_PERCENT') && (b.value <= 0 || b.value > 100)) {
        throw AppError.validation('Discount benefits need a percentage between 1 and 100.');
      }
    }
  }

  async createPlan(input: MembershipPlanInput) {
    const tenantId = RequestContext.requireTenantId();
    this.validateBenefits(input.benefits);
    const { benefits, ...data } = input;
    const plan = await this.db.membershipPlan.create({ data: { ...data, tenantId, benefits: { create: benefits } } });
    await this.audit.log({ action: 'MEMBERSHIP_PLAN_CREATED', entityType: 'MembershipPlan', entityId: plan.id, newValues: input });
    return this.getPlan(plan.id);
  }

  async updatePlan(id: string, input: Partial<MembershipPlanInput>) {
    const before = await this.getPlan(id);
    if (input.benefits) this.validateBenefits(input.benefits);
    const { benefits, ...data } = input;
    await this.db.$transaction(async (tx) => {
      await tx.membershipPlan.update({ where: { id }, data });
      if (benefits) {
        // Usage rows reference benefit ids, so benefits already used by members are kept and updated in place.
        const used = new Set((await tx.membershipUsage.findMany({ where: { membership: { membershipPlanId: id } }, select: { benefitId: true }, distinct: ['benefitId'] })).map((u) => u.benefitId));
        const existing = before.benefits;
        const keep: string[] = [];
        for (const b of benefits) {
          const match = existing.find((e) => e.type === b.type && (e.serviceId ?? null) === (b.serviceId ?? null) && (e.categoryId ?? null) === (b.categoryId ?? null) && !keep.includes(e.id));
          if (match) {
            keep.push(match.id);
            await tx.membershipPlanBenefit.update({ where: { id: match.id }, data: { value: b.value, quantity: b.quantity ?? null } });
          } else {
            await tx.membershipPlanBenefit.create({ data: { ...b, planId: id } });
          }
        }
        const removable = existing.filter((e) => !keep.includes(e.id) && !used.has(e.id)).map((e) => e.id);
        if (removable.length) await tx.membershipPlanBenefit.deleteMany({ where: { id: { in: removable } } });
      }
    });
    await this.audit.log({ action: num(before.price) !== num(input.price ?? before.price) ? 'PRICE_CHANGED' : 'MEMBERSHIP_PLAN_UPDATED', entityType: 'MembershipPlan', entityId: id, oldValues: { price: before.price, status: before.status }, newValues: input });
    return this.getPlan(id);
  }

  // ---------- customer memberships ----------

  private present(m: MembershipRow) {
    return { ...m, customer: maskContact(m.customer), benefits: this.benefitState(m) };
  }

  private benefitState(m: MembershipRow): ActiveBenefit[] {
    return m.plan.benefits.map((b) => {
      const used = m.usages.filter((u) => u.benefitId === b.id).reduce((s, u) => s + u.quantity, 0);
      return {
        membershipId: m.id,
        membershipName: m.plan.name,
        benefitId: b.id,
        type: b.type,
        serviceId: b.serviceId,
        categoryId: b.categoryId,
        value: num(b.value),
        quantity: b.quantity,
        remaining: b.type === 'INCLUDED_SESSIONS' ? Math.max(0, (b.quantity ?? 0) - used) : null,
      };
    });
  }

  async list(q: { page: number; pageSize: number; customerId?: string; status?: string; planId?: string; search?: string; expiringInDays?: number }) {
    const where: Prisma.CustomerMembershipWhereInput = {};
    if (q.customerId) where.customerId = q.customerId;
    if (q.planId) where.membershipPlanId = q.planId;
    if (q.status) where.status = { in: q.status.split(',') as CustomerMembershipStatus[] };
    if (q.search) where.customer = { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] };
    if (q.expiringInDays) {
      where.status = 'ACTIVE';
      where.expiresAt = { gte: new Date(), lte: addDays(new Date(), q.expiringInDays) };
    }
    const [items, total] = await Promise.all([
      this.db.customerMembership.findMany({ where, include: membershipInclude, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.customerMembership.count({ where }),
    ]);
    return paged(items.map((m) => this.present(m)), total, q);
  }

  async get(id: string) {
    const m = await this.db.customerMembership.findFirst({ where: { id }, include: membershipInclude });
    if (!m) throw AppError.notFound('Membership');
    const history = await this.db.membershipUsage.findMany({ where: { customerMembershipId: id }, orderBy: { usedAt: 'desc' }, take: 50 });
    return { ...this.present(m), usageHistory: history };
  }

  async activeFor(customerId: string, client: DbOrTx = this.db) {
    const now = new Date();
    const rows = await client.customerMembership.findMany({ where: { customerId, status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gte: now } }, include: membershipInclude });
    return rows.map((m) => this.present(m));
  }

  async activeBenefits(customerId: string, client: DbOrTx = this.db): Promise<ActiveBenefit[]> {
    return (await this.activeFor(customerId, client)).flatMap((m) => m.benefits);
  }

  async createPending(tx: DbOrTx, input: { customerId: string; planId: string; branchId: string; invoiceId: string; autoRenew?: boolean; startDate?: string }) {
    const tenantId = RequestContext.requireTenantId();
    const plan = await tx.membershipPlan.findFirst({ where: { id: input.planId } });
    if (!plan) throw AppError.notFound('Membership plan');
    if (plan.status !== 'ACTIVE') throw AppError.invalidState(`${plan.name} is no longer on sale.`);
    const startedAt = input.startDate ? dateOnly(input.startDate) : new Date();
    return tx.customerMembership.create({
      data: {
        tenantId,
        customerId: input.customerId,
        membershipPlanId: plan.id,
        branchId: input.branchId,
        purchaseInvoiceId: input.invoiceId,
        startedAt,
        expiresAt: addDays(startedAt, plan.durationDays),
        autoRenew: input.autoRenew ?? false,
        status: 'PENDING_PAYMENT',
      },
    });
  }

  async activateForInvoice(tx: DbOrTx, invoiceId: string, paidAt = new Date()) {
    const pending = await tx.customerMembership.findMany({ where: { purchaseInvoiceId: invoiceId, status: 'PENDING_PAYMENT' }, include: { plan: true } });
    for (const m of pending) {
      // A future-dated start is honoured; otherwise the period runs from payment.
      const startedAt = m.startedAt > paidAt ? m.startedAt : paidAt;
      await tx.customerMembership.update({ where: { id: m.id }, data: { status: 'ACTIVE', startedAt, expiresAt: addDays(startedAt, m.plan.durationDays) } });
      await this.activity.record({ customerId: m.customerId, branchId: m.branchId, type: 'MEMBERSHIP_PURCHASED', title: `Joined ${m.plan.name}`, refType: 'CustomerMembership', refId: m.id, occurredAt: paidAt }, tx);
      await this.events.publish(DomainEvents.MEMBERSHIP_PURCHASED, { customerMembershipId: m.id, customerId: m.customerId, planId: m.membershipPlanId, branchId: m.branchId, invoiceId }, tx);
    }
    return pending.length;
  }

  async cancelForInvoice(tx: DbOrTx, invoiceId: string) {
    await tx.customerMembership.updateMany({ where: { purchaseInvoiceId: invoiceId, status: { in: ['PENDING_PAYMENT', 'ACTIVE'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  }

  async cancel(id: string, reason?: string) {
    const m = await this.db.customerMembership.findFirst({ where: { id }, include: { plan: true } });
    if (!m) throw AppError.notFound('Membership');
    if (m.status === 'CANCELLED' || m.status === 'EXPIRED') throw AppError.invalidState(`Membership is already ${m.status.toLowerCase()}.`);
    await this.db.$transaction(async (tx) => {
      await tx.customerMembership.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), autoRenew: false } });
      await this.activity.record({ customerId: m.customerId, branchId: m.branchId, type: 'MEMBERSHIP_CANCELLED', title: `${m.plan.name} cancelled`, refType: 'CustomerMembership', refId: id, meta: { reason } }, tx);
    });
    await this.audit.log({ action: 'MEMBERSHIP_CANCELLED', entityType: 'CustomerMembership', entityId: id, newValues: { reason } });
    return this.get(id);
  }

  async setAutoRenew(id: string, autoRenew: boolean) {
    const m = await this.db.customerMembership.findFirst({ where: { id } });
    if (!m) throw AppError.notFound('Membership');
    await this.db.customerMembership.update({ where: { id }, data: { autoRenew } });
    return this.get(id);
  }

  /** Consumes included sessions; locked on the membership row so two checkouts cannot overdraw. */
  async recordUsage(tx: DbOrTx, input: { membershipId: string; benefitId: string; quantity: number; sessionId?: string | null; invoiceId?: string | null }) {
    await tx.$queryRaw`SELECT id FROM customer_memberships WHERE id = ${input.membershipId} FOR UPDATE`;
    const m = await tx.customerMembership.findFirst({ where: { id: input.membershipId }, include: membershipInclude });
    if (!m || m.status !== 'ACTIVE' || m.expiresAt < new Date()) throw AppError.badRequest(ErrorCode.MEMBERSHIP_INACTIVE, 'This membership is not active.');
    if (input.sessionId) {
      const existing = await tx.membershipUsage.findFirst({ where: { customerMembershipId: m.id, benefitId: input.benefitId, sessionId: input.sessionId } });
      if (existing) return existing;
    }
    const benefit = this.benefitState(m).find((b) => b.benefitId === input.benefitId);
    if (!benefit || benefit.type !== 'INCLUDED_SESSIONS') throw AppError.validation('Benefit does not include sessions.');
    if ((benefit.remaining ?? 0) < input.quantity) throw AppError.badRequest(ErrorCode.MEMBERSHIP_INACTIVE, `Only ${benefit.remaining} included sessions left on ${m.plan.name}.`);
    return tx.membershipUsage.create({
      data: { tenantId: m.tenantId, customerMembershipId: m.id, benefitId: input.benefitId, quantity: input.quantity, sessionId: input.sessionId ?? null, invoiceId: input.invoiceId ?? null },
    });
  }

  async releaseUsageForInvoice(tx: DbOrTx, invoiceId: string) {
    await tx.membershipUsage.deleteMany({ where: { invoiceId } });
  }

  async expireDue(now = new Date()) {
    const res = await this.db.customerMembership.updateMany({ where: { status: 'ACTIVE', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
    return res.count;
  }
}
