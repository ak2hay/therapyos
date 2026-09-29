import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FEATURE_FLAG_KEYS } from '@therapyos/types';
import { adminFeatureFlagSchema, adminSubscriptionSchema, adminTenantQuery, subscriptionPlanSchema, tenantStatusSchema } from '@therapyos/validation';
import Redis from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { InjectRedis } from '../../common/redis/redis.module';
import { dateOnly } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { QUEUES, QueueName, QueueService } from '../../jobs/queue.service';
import { ProviderFactory } from '../../integrations/provider.factory';
import { StorageService } from '../../integrations/storage.service';
import { LAPSED_REASON, planPrice, SubscriptionService } from '../subscription/subscription.service';

const DAY = 86_400_000;
const PAID = ['SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

/**
 * Platform console queries. Platform admins have no tenant context, so the tenant extension does
 * not scope these queries: every tenant filter here is explicit.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly features: FeaturesService,
    private readonly subscriptions: SubscriptionService,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
    private readonly providers: ProviderFactory,
  ) {}

  // ---------- metrics ----------

  async metrics() {
    const now = Date.now();
    const d30 = new Date(now - 30 * DAY);
    const sixMonthsAgo = new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1);
    const [byStatus, newTenants, subs, churned, collected, gmv, openTickets, signups, revenueByMonth] = await Promise.all([
      this.db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.tenant.count({ where: { createdAt: { gte: d30 } } }),
      this.db.tenantSubscription.findMany({ where: { isCurrent: true }, include: { plan: { select: { id: true, code: true, name: true, monthlyPrice: true, annualPrice: true } } } }),
      this.db.tenantSubscription.count({ where: { isCurrent: true, status: { in: ['CANCELLED', 'EXPIRED'] }, updatedAt: { gte: d30 } } }),
      this.db.subscriptionInvoice.aggregate({ where: { status: 'PAID', paidAt: { gte: d30 } }, _sum: { amount: true } }),
      this.db.payment.aggregate({ where: { status: { in: [...PAID] }, paidAt: { gte: d30 } }, _sum: { amount: true } }),
      this.db.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.db.$queryRaw<{ month: string; count: number }[]>`
        SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, count(*)::int AS count
        FROM tenants WHERE "createdAt" >= ${sixMonthsAgo} GROUP BY 1 ORDER BY 1`,
      this.db.$queryRaw<{ month: string; amount: unknown }[]>`
        SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS month, sum(amount) AS amount
        FROM subscription_invoices WHERE status = 'PAID' AND "paidAt" >= ${sixMonthsAgo} GROUP BY 1 ORDER BY 1`,
    ]);
    const paying = subs.filter((s) => ['ACTIVE', 'PAST_DUE'].includes(s.status));
    const mrrOf = (list: typeof subs) => round2(list.reduce((sum, s) => sum + (s.billingCycle === 'ANNUAL' ? planPrice(s.plan, 'ANNUAL') / 12 : planPrice(s.plan, 'MONTHLY')), 0));
    const mrr = mrrOf(paying);
    const plans = new Map<string, { planId: string; code: string; name: string; tenants: number; paying: number; mrr: number }>();
    for (const s of subs) {
      const p = plans.get(s.planId) ?? { planId: s.planId, code: s.plan.code, name: s.plan.name, tenants: 0, paying: 0, mrr: 0 };
      p.tenants++;
      if (['ACTIVE', 'PAST_DUE'].includes(s.status)) {
        p.paying++;
        p.mrr = round2(p.mrr + mrrOf([s]));
      }
      plans.set(s.planId, p);
    }
    const subStatus = subs.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
    const trialsEndingSoon = subs.filter((s) => s.status === 'TRIALING' && s.trialEndDate && s.trialEndDate.getTime() - now < 7 * DAY && s.trialEndDate.getTime() > now).length;
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return {
      tenants: { total: byStatus.reduce((s, r) => s + r._count._all, 0), byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])), newLast30Days: newTenants },
      subscriptions: { byStatus: subStatus, trialsEndingSoon },
      mrr,
      arr: round2(mrr * 12),
      arpa: paying.length ? round2(mrr / paying.length) : 0,
      churnRate: paying.length + churned ? round2((churned / (paying.length + churned)) * 100) : 0,
      churnedLast30Days: churned,
      collectedLast30Days: round2(num(collected._sum.amount)),
      gmvLast30Days: round2(num(gmv._sum.amount)),
      openTickets,
      plans: [...plans.values()].sort((a, b) => b.mrr - a.mrr),
      trend: months.map((m) => ({
        month: m,
        signups: signups.find((s) => s.month === m)?.count ?? 0,
        revenue: round2(num(revenueByMonth.find((r) => r.month === m)?.amount as number)),
      })),
    };
  }

  // ---------- tenants ----------

  async tenants(q: z.infer<typeof adminTenantQuery>) {
    const where: Prisma.TenantWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.search) where.OR = [{ name: { contains: q.search, mode: 'insensitive' } }, { slug: { contains: q.search, mode: 'insensitive' } }, { email: { contains: q.search, mode: 'insensitive' } }];
    if (q.planId || q.subscriptionStatus) {
      where.id = { in: (await this.db.tenantSubscription.findMany({ where: { isCurrent: true, ...(q.planId ? { planId: q.planId } : {}), ...(q.subscriptionStatus ? { status: q.subscriptionStatus } : {}) }, select: { tenantId: true } })).map((s) => s.tenantId) };
    }
    const [items, total] = await Promise.all([
      this.db.tenant.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.tenant.count({ where }),
    ]);
    const ids = items.map((t) => t.id);
    const [subs, branches, users, customers] = await Promise.all([
      this.db.tenantSubscription.findMany({ where: { tenantId: { in: ids }, isCurrent: true }, include: { plan: { select: { id: true, code: true, name: true } } } }),
      this.db.branch.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } }),
      this.db.user.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, status: { not: 'DISABLED' } }, _count: { _all: true }, _max: { lastLoginAt: true } }),
      this.db.customer.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
    ]);
    const sub = new Map(subs.map((s) => [s.tenantId, s]));
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const [B, U, C] = [count(branches), count(users), count(customers)];
    const lastSeen = new Map(users.map((u) => [u.tenantId, u._max.lastLoginAt]));
    return paged(
      items.map((t) => {
        const s = sub.get(t.id);
        return {
          ...t,
          onboardingData: undefined,
          subscription: s ? { id: s.id, status: s.status, billingCycle: s.billingCycle, plan: s.plan, trialEndDate: s.trialEndDate, renewalDate: s.renewalDate, cancelledAt: s.cancelledAt } : null,
          usage: { branches: B.get(t.id) ?? 0, users: U.get(t.id) ?? 0, customers: C.get(t.id) ?? 0 },
          lastActiveAt: lastSeen.get(t.id) ?? null,
        };
      }),
      total,
      q,
    );
  }

  async tenant(id: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) throw AppError.notFound('Tenant');
    const d30 = new Date(Date.now() - 30 * DAY);
    const [branding, subscriptions, invoices, limits, usage, features, overrides, branches, owners, audit, tickets, gmv, sessions] = await Promise.all([
      this.db.tenantBranding.findUnique({ where: { tenantId: id } }),
      this.db.tenantSubscription.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, include: { plan: { select: { id: true, code: true, name: true } } } }),
      this.db.subscriptionInvoice.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 12 }),
      this.features.getLimits(id),
      this.features.getUsage(id),
      this.features.getFeatures(id),
      this.db.featureFlag.findMany({ where: { tenantId: id } }),
      this.db.branch.findMany({ where: { tenantId: id }, select: { id: true, name: true, code: true, city: true, status: true }, orderBy: { name: 'asc' } }),
      this.db.user.findMany({ where: { tenantId: id, userRoles: { some: { role: { key: 'OWNER' } } } }, select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true } }),
      this.db.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, action: true, entityType: true, actorType: true, createdAt: true } }),
      this.db.supportTicket.findMany({ where: { tenantId: id }, orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, subject: true, status: true, priority: true, updatedAt: true } }),
      this.db.payment.aggregate({ where: { tenantId: id, status: { in: [...PAID] }, paidAt: { gte: d30 } }, _sum: { amount: true } }),
      this.db.therapySession.count({ where: { tenantId: id, status: 'COMPLETED', completedAt: { gte: d30 } } }),
    ]);
    const { onboardingData: _o, ...rest } = tenant;
    return {
      ...rest,
      branding,
      subscription: subscriptions.find((s) => s.isCurrent) ?? null,
      subscriptionHistory: subscriptions,
      invoices,
      limits,
      usage,
      features,
      overrides: overrides.map((o) => ({ key: o.key, enabled: o.enabled })),
      branches,
      owners,
      audit,
      tickets,
      activity: { gmvLast30Days: round2(num(gmv._sum.amount)), sessionsLast30Days: sessions },
    };
  }

  async setStatus(id: string, input: z.infer<typeof tenantStatusSchema>) {
    const before = await this.db.tenant.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Tenant');
    if (input.status === 'SUSPENDED' && !input.reason) throw AppError.validation('Give a reason for the suspension; the business sees it.');
    await this.db.tenant.update({ where: { id }, data: { status: input.status, suspendedReason: input.status === 'ACTIVE' ? null : input.reason ?? null } });
    await this.authz.invalidateTenant(id);
    await this.audit.log({ tenantId: id, action: `TENANT_${input.status}`, entityType: 'Tenant', entityId: id, oldValues: { status: before.status }, newValues: input });
    return this.tenant(id);
  }

  async setSubscription(id: string, input: z.infer<typeof adminSubscriptionSchema>) {
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) throw AppError.notFound('Tenant');
    let current = await this.db.tenantSubscription.findFirst({ where: { tenantId: id, isCurrent: true } });
    if (input.planId && input.planId !== current?.planId) {
      current = await this.subscriptions.activate(id, input.planId, input.billingCycle ?? current?.billingCycle ?? 'MONTHLY', { provider: 'manual' });
    }
    if (!current) throw AppError.invalidState('The tenant has no subscription; choose a plan.');
    const data: Prisma.TenantSubscriptionUpdateInput = {};
    if (input.billingCycle) data.billingCycle = input.billingCycle;
    if (input.status) data.status = input.status;
    if (input.trialEndDate) Object.assign(data, { trialEndDate: dateOnly(input.trialEndDate), ...(input.status ? {} : { status: 'TRIALING' }) });
    if (input.renewalDate) data.renewalDate = dateOnly(input.renewalDate);
    if (input.status && ['ACTIVE', 'TRIALING'].includes(input.status)) data.cancelledAt = null;
    if (Object.keys(data).length) await this.db.tenantSubscription.update({ where: { id: current.id }, data });
    const effective = input.status ?? (input.trialEndDate ? 'TRIALING' : undefined);
    if (effective && ['ACTIVE', 'TRIALING'].includes(effective) && tenant.status === 'SUSPENDED' && tenant.suspendedReason === LAPSED_REASON) {
      await this.db.tenant.update({ where: { id }, data: { status: 'ACTIVE', suspendedReason: null } });
    }
    await Promise.all([this.features.invalidate(id), this.authz.invalidateTenant(id)]);
    await this.audit.log({ tenantId: id, action: 'SUBSCRIPTION_ADMIN_UPDATED', entityType: 'TenantSubscription', entityId: current.id, newValues: input });
    return this.tenant(id);
  }

  // ---------- feature flags ----------

  async flags() {
    const [flags, plans, tenants] = await Promise.all([
      this.db.featureFlag.findMany(),
      this.db.subscriptionPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, features: true } }),
      this.db.tenant.findMany({ select: { id: true, name: true } }),
    ]);
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    const keys = [...new Set([...FEATURE_FLAG_KEYS, ...flags.map((f) => f.key)])];
    return keys.map((key) => {
      const global = flags.find((f) => f.key === key && f.tenantId === null);
      return {
        key,
        global: global ? global.enabled : null,
        plans: plans.filter((p) => p.features.includes(key)).map((p) => p.code),
        overrides: flags.filter((f) => f.key === key && f.tenantId).map((f) => ({ tenantId: f.tenantId!, tenantName: tenantName.get(f.tenantId!) ?? f.tenantId!, enabled: f.enabled })),
      };
    });
  }

  /** `enabled: null` removes the flag (global default or tenant override) so plan features apply. */
  async setFlag(input: z.infer<typeof adminFeatureFlagSchema>) {
    const tenantId = input.tenantId ?? null;
    if (tenantId && !(await this.db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw AppError.notFound('Tenant');
    const existing = await this.db.featureFlag.findFirst({ where: { key: input.key, tenantId } });
    if (input.enabled === null) {
      if (existing) await this.db.featureFlag.delete({ where: { id: existing.id } });
    } else if (existing) {
      await this.db.featureFlag.update({ where: { id: existing.id }, data: { enabled: input.enabled } });
    } else {
      await this.db.featureFlag.create({ data: { key: input.key, tenantId, enabled: input.enabled } });
    }
    const affected = tenantId ? [tenantId] : (await this.db.tenant.findMany({ select: { id: true } })).map((t) => t.id);
    await Promise.all(affected.map((t) => this.features.invalidate(t)));
    await this.audit.log({ tenantId, action: 'FEATURE_FLAG_SET', entityType: 'FeatureFlag', entityId: input.key, oldValues: existing ? { enabled: existing.enabled } : null, newValues: input });
    return this.flags();
  }

  // ---------- plans ----------

  async plans() {
    const [plans, subs] = await Promise.all([
      this.db.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.db.tenantSubscription.groupBy({ by: ['planId', 'status'], where: { isCurrent: true }, _count: { _all: true } }),
    ]);
    return plans.map((p) => ({
      ...p,
      subscribers: subs.filter((s) => s.planId === p.id).reduce((sum, s) => sum + s._count._all, 0),
      paying: subs.filter((s) => s.planId === p.id && ['ACTIVE', 'PAST_DUE'].includes(s.status)).reduce((sum, s) => sum + s._count._all, 0),
    }));
  }

  async createPlan(input: z.infer<typeof subscriptionPlanSchema>) {
    if (await this.db.subscriptionPlan.findUnique({ where: { code: input.code } })) throw AppError.conflict(`A plan with code ${input.code} already exists.`);
    const plan = await this.db.subscriptionPlan.create({ data: input });
    await this.audit.log({ action: 'PLAN_CREATED', entityType: 'SubscriptionPlan', entityId: plan.id, newValues: input });
    return plan;
  }

  async updatePlan(id: string, input: Partial<z.infer<typeof subscriptionPlanSchema>>) {
    const before = await this.db.subscriptionPlan.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Plan');
    if (input.code && input.code !== before.code && (await this.db.subscriptionPlan.findUnique({ where: { code: input.code } }))) throw AppError.conflict(`A plan with code ${input.code} already exists.`);
    const plan = await this.db.subscriptionPlan.update({ where: { id }, data: input });
    const tenants = await this.db.tenantSubscription.findMany({ where: { planId: id, isCurrent: true }, select: { tenantId: true } });
    await Promise.all(tenants.map((t) => this.features.invalidate(t.tenantId)));
    await this.audit.log({ action: 'PLAN_UPDATED', entityType: 'SubscriptionPlan', entityId: id, oldValues: before, newValues: input });
    return plan;
  }

  // ---------- system ----------

  private async timed<T>(fn: () => Promise<T>) {
    const t = performance.now();
    try {
      await fn();
      return { status: 'up' as const, latencyMs: Math.round(performance.now() - t) };
    } catch (e) {
      return { status: 'down' as const, latencyMs: Math.round(performance.now() - t), error: (e as Error).message };
    }
  }

  async system() {
    const since = new Date(Date.now() - DAY);
    const [database, redis, queues, outbox, oldestPending, failedEvents, notifications, lifecycle] = await Promise.all([
      this.timed(() => this.db.$queryRaw`SELECT 1`),
      this.timed(() => this.redis.ping()),
      Promise.all(
        (Object.values(QUEUES) as QueueName[]).map(async (name) => {
          try {
            return { name, ...(await this.queues.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')) };
          } catch (e) {
            return { name, error: (e as Error).message };
          }
        }),
      ),
      this.db.domainEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.domainEvent.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.db.domainEvent.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, tenantId: true, attempts: true, error: true, createdAt: true } }),
      this.db.notificationLog.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      this.db.tenantSubscription.count({ where: { isCurrent: true, status: 'PAST_DUE' } }),
    ]);
    const mem = process.memoryUsage();
    const e = env();
    const sources = await this.providers.sources(null);
    const label = (name: string, source: string) => (source === 'mock' ? 'mock' : `${name} (${source === 'env' ? 'server env' : 'platform'})`);
    return {
      checkedAt: new Date(),
      services: { database, redis, storage: { status: 'up' as const, driver: this.storage.driver } },
      queues,
      outbox: {
        byStatus: Object.fromEntries(outbox.map((o) => [o.status, o._count._all])),
        oldestPendingSeconds: oldestPending ? Math.round((Date.now() - oldestPending.createdAt.getTime()) / 1000) : 0,
        recentFailures: failedEvents,
      },
      notificationsLast24h: Object.fromEntries(notifications.map((n) => [n.status, n._count._all])),
      pastDueSubscriptions: lifecycle,
      process: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1_048_576), heapUsedMb: Math.round(mem.heapUsed / 1_048_576), node: process.version, pid: process.pid, env: e.NODE_ENV },
      providers: {
        payment: label('razorpay', sources.RAZORPAY),
        sms: label('msg91', sources.MSG91),
        otpWidget: label('msg91 widget', sources.MSG91_OTP_WIDGET),
        email: label('smtp', sources.SMTP),
        whatsapp: label('cloud', sources.WHATSAPP_CLOUD),
        llm: label('openai', sources.OPENAI),
        storage: e.STORAGE_DRIVER,
      },
    };
  }

  async runLifecycle() {
    const result = await this.subscriptions.lifecycle();
    await this.audit.log({ action: 'SUBSCRIPTION_LIFECYCLE_RUN', entityType: 'TenantSubscription', newValues: result });
    return result;
  }
}
