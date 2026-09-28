import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BillingCycle, TenantSubscription } from '@prisma/client';
import { PERMISSIONS } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit.service';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { PaymentProvider } from '../../integrations/payment.provider';
import { NotificationsService } from '../notifications/notifications.service';

const DAY = 86_400_000;
export const LAPSED_REASON = 'Subscription lapsed';

export const addCycle = (from: Date, cycle: BillingCycle) => {
  const d = new Date(from);
  if (cycle === 'ANNUAL') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

export const planPrice = (plan: { monthlyPrice: unknown; annualPrice: unknown }, cycle: BillingCycle) => num((cycle === 'ANNUAL' ? plan.annualPrice : plan.monthlyPrice) as number);

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly features: FeaturesService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly provider: PaymentProvider,
    private readonly notifications: NotificationsService,
  ) {}

  private current(tenantId: string) {
    return this.db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: true }, include: { plan: true } });
  }

  async summary() {
    const tenantId = RequestContext.requireTenantId();
    const [subscription, plans, invoices, limits, usage, features, pending] = await Promise.all([
      this.current(tenantId),
      this.db.subscriptionPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } }),
      this.db.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 12 }),
      this.features.getLimits(tenantId),
      this.features.getUsage(tenantId),
      this.features.getFeatures(tenantId),
      this.db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: false, provider: 'razorpay', status: 'TRIALING', createdAt: { gte: new Date(Date.now() - DAY) } }, include: { plan: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    const trialDaysLeft = subscription?.status === 'TRIALING' && subscription.trialEndDate ? Math.max(0, Math.ceil((subscription.trialEndDate.getTime() - Date.now()) / DAY)) : null;
    return { subscription, trialDaysLeft, plans, invoices, limits, usage, features, pendingChange: pending ? { plan: pending.plan, billingCycle: pending.billingCycle } : null, provider: this.provider.name };
  }

  private async assertFits(tenantId: string, plan: { name: string; maxBranches: number; maxUsers: number; maxCustomers: number }) {
    const usage = await this.features.getUsage(tenantId);
    const over = [
      usage.branches > plan.maxBranches && `${usage.branches} active branches (plan allows ${plan.maxBranches})`,
      usage.users > plan.maxUsers && `${usage.users} staff accounts (plan allows ${plan.maxUsers})`,
      usage.customers > plan.maxCustomers && `${usage.customers} customers (plan allows ${plan.maxCustomers})`,
    ].filter(Boolean);
    if (over.length) {
      throw new AppError(ErrorCode.PLAN_LIMIT_REACHED, `You are using more than ${plan.name} allows: ${over.join('; ')}.`, HttpStatus.PAYMENT_REQUIRED, { usage });
    }
  }

  /**
   * Switches plan. With the mock gateway the change is charged and applied immediately; with
   * Razorpay a gateway subscription is created and the change applies when it is activated.
   */
  async change(planId: string, billingCycle: BillingCycle) {
    const tenantId = RequestContext.requireTenantId();
    const plan = await this.db.subscriptionPlan.findFirst({ where: { id: planId, status: 'ACTIVE' } });
    if (!plan) throw AppError.notFound('Plan');
    const current = await this.current(tenantId);
    if (current && current.planId === planId && current.billingCycle === billingCycle && current.status === 'ACTIVE' && !current.cancelledAt) {
      throw AppError.invalidState('You are already on this plan.');
    }
    await this.assertFits(tenantId, plan);

    if (this.provider.name === 'razorpay') {
      const planRef = (JSON.parse(env().RAZORPAY_PLAN_MAP) as Record<string, string>)[`${plan.code}:${billingCycle}`];
      if (!planRef) throw AppError.invalidState(`Online payment is not configured for ${plan.name} (${billingCycle.toLowerCase()}). Contact support.`);
      const gw = await this.provider.createSubscription(planRef, billingCycle === 'ANNUAL' ? 10 : 120, { tenantId, planCode: plan.code });
      await this.db.tenantSubscription.create({
        data: { tenantId, planId, billingCycle, status: 'TRIALING', isCurrent: false, provider: 'razorpay', providerSubscriptionId: gw.subscriptionId },
      });
      await this.audit.log({ action: 'SUBSCRIPTION_CHECKOUT_STARTED', entityType: 'TenantSubscription', newValues: { plan: plan.code, billingCycle, providerSubscriptionId: gw.subscriptionId } });
      return { status: 'PENDING_PAYMENT', checkoutUrl: gw.shortUrl ?? null };
    }

    const sub = await this.activate(tenantId, planId, billingCycle, { provider: this.provider.name, providerSubscriptionId: (await this.provider.createSubscription(plan.code, 1)).subscriptionId, charge: true });
    await this.audit.log({ action: 'SUBSCRIPTION_CHANGED', entityType: 'TenantSubscription', entityId: sub.id, oldValues: current ? { plan: current.plan.code, billingCycle: current.billingCycle, status: current.status } : null, newValues: { plan: plan.code, billingCycle } });
    return { status: 'ACTIVE', subscription: sub };
  }

  /** Makes `planId` the current subscription, optionally recording a paid invoice for the first period. */
  async activate(tenantId: string, planId: string, billingCycle: BillingCycle, opts: { provider: string; providerSubscriptionId?: string; charge?: boolean; paymentId?: string; existingId?: string }) {
    const plan = await this.db.subscriptionPlan.findUniqueOrThrow({ where: { id: planId } });
    const now = new Date();
    const renewalDate = addCycle(now, billingCycle);
    const sub = await this.db.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({ where: { tenantId, isCurrent: true, ...(opts.existingId ? { id: { not: opts.existingId } } : {}) }, data: { isCurrent: false, status: 'CANCELLED', cancelledAt: now } });
      const data = { planId, billingCycle, status: 'ACTIVE' as const, startDate: now, renewalDate, trialEndDate: null, cancelledAt: null, isCurrent: true, provider: opts.provider, providerSubscriptionId: opts.providerSubscriptionId };
      const s = opts.existingId
        ? await tx.tenantSubscription.update({ where: { id: opts.existingId }, data, include: { plan: true } })
        : await tx.tenantSubscription.create({ data: { tenantId, ...data }, include: { plan: true } });
      if (opts.charge || opts.paymentId) {
        await tx.subscriptionInvoice.create({
          data: { tenantId, subscriptionId: s.id, amount: planPrice(plan, billingCycle), status: 'PAID', periodStart: now, periodEnd: renewalDate, paidAt: now, providerPaymentId: opts.paymentId ?? `mock_${s.id}` },
        });
      }
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { subscriptionPlanId: planId, ...(tenant.status === 'SUSPENDED' && tenant.suspendedReason === LAPSED_REASON ? { status: 'ACTIVE', suspendedReason: null } : {}) },
      });
      return s;
    });
    await Promise.all([this.features.invalidate(tenantId), this.authz.invalidateTenant(tenantId)]);
    return sub;
  }

  async cancel() {
    const tenantId = RequestContext.requireTenantId();
    const current = await this.current(tenantId);
    if (!current || !['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(current.status)) throw AppError.invalidState('There is no active subscription to cancel.');
    if (current.cancelledAt) throw AppError.invalidState('The subscription is already set to end.');
    const updated = await this.db.tenantSubscription.update({ where: { id: current.id }, data: { cancelledAt: new Date() }, include: { plan: true } });
    await this.audit.log({ action: 'SUBSCRIPTION_CANCELLED', entityType: 'TenantSubscription', entityId: current.id, newValues: { endsAt: current.renewalDate ?? current.trialEndDate } });
    return updated;
  }

  async resume() {
    const tenantId = RequestContext.requireTenantId();
    const current = await this.current(tenantId);
    if (!current?.cancelledAt || !['ACTIVE', 'TRIALING'].includes(current.status)) throw AppError.invalidState('Nothing to resume.');
    const updated = await this.db.tenantSubscription.update({ where: { id: current.id }, data: { cancelledAt: null }, include: { plan: true } });
    await this.audit.log({ action: 'SUBSCRIPTION_RESUMED', entityType: 'TenantSubscription', entityId: current.id });
    return updated;
  }

  /** Razorpay subscription webhooks (signature-verified). Subscriptions are found by gateway id. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined, body: any) {
    if (!rawBody || !this.provider.verifyWebhookSignature(rawBody, signature)) {
      throw AppError.badRequest(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid webhook signature.');
    }
    const event: string = body?.event ?? '';
    const gwId: string | undefined = body?.payload?.subscription?.entity?.id;
    if (!event.startsWith('subscription.') || !gwId) return { received: true, ignored: event };
    const sub = await this.db.tenantSubscription.findFirst({ where: { providerSubscriptionId: gwId } });
    if (!sub) return { received: true, ignored: 'unknown subscription' };
    const paymentId: string | undefined = body?.payload?.payment?.entity?.id;

    if (event === 'subscription.activated' || event === 'subscription.charged') {
      if (!sub.isCurrent || sub.status !== 'ACTIVE') {
        await this.activate(sub.tenantId, sub.planId, sub.billingCycle, { provider: 'razorpay', providerSubscriptionId: gwId, existingId: sub.id, paymentId: paymentId ?? `rzp_${gwId}` });
      } else if (event === 'subscription.charged' && paymentId) {
        const dup = await this.db.subscriptionInvoice.findFirst({ where: { providerPaymentId: paymentId } });
        if (!dup) {
          const plan = await this.db.subscriptionPlan.findUniqueOrThrow({ where: { id: sub.planId } });
          const start = sub.renewalDate ?? new Date();
          const end = addCycle(start, sub.billingCycle);
          await this.db.$transaction([
            this.db.subscriptionInvoice.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, amount: planPrice(plan, sub.billingCycle), status: 'PAID', periodStart: start, periodEnd: end, paidAt: new Date(), providerPaymentId: paymentId } }),
            this.db.tenantSubscription.update({ where: { id: sub.id }, data: { renewalDate: end, status: 'ACTIVE' } }),
          ]);
        }
      }
    } else if (event === 'subscription.halted' || event === 'subscription.pending') {
      await this.db.tenantSubscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
    } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
      await this.db.tenantSubscription.update({ where: { id: sub.id }, data: { cancelledAt: sub.cancelledAt ?? new Date() } });
    }
    await this.features.invalidate(sub.tenantId);
    return { received: true, event };
  }

  private async alertOwners(tenantId: string, title: string, body: string, key: string) {
    await RequestContext.runAsTenant(tenantId, () =>
      this.notifications.notifyStaff({ permission: PERMISSIONS.SUBSCRIPTION_MANAGE, type: 'SUBSCRIPTION', title, body, link: '/settings?tab=subscription', dedupeKey: key }),
    ).catch((e) => this.logger.warn(`Subscription alert failed for ${tenantId}: ${(e as Error).message}`));
  }

  private async suspend(sub: TenantSubscription, status: 'EXPIRED' | 'CANCELLED') {
    await this.db.$transaction([
      this.db.tenantSubscription.update({ where: { id: sub.id }, data: { status } }),
      this.db.tenant.updateMany({ where: { id: sub.tenantId, status: { in: ['ACTIVE', 'ONBOARDING'] } }, data: { status: 'SUSPENDED', suspendedReason: LAPSED_REASON } }),
    ]);
    await Promise.all([this.features.invalidate(sub.tenantId), this.authz.invalidateTenant(sub.tenantId)]);
  }

  /**
   * Platform-wide subscription lifecycle, run hourly: trial reminders and expiry, mock renewals,
   * past-due grace period and suspension. Every transition is guarded so reruns are no-ops.
   */
  async lifecycle(now = new Date()) {
    const grace = env().SUBSCRIPTION_GRACE_DAYS * DAY;
    const result = { trialReminders: 0, trialsEnded: 0, renewed: 0, pastDue: 0, suspended: 0, ended: 0 };
    const subs = await this.db.tenantSubscription.findMany({ where: { isCurrent: true, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: true } });
    for (const s of subs) {
      try {
        const endsAt = s.status === 'TRIALING' ? s.trialEndDate : s.renewalDate;
        if (!endsAt) continue;
        const left = endsAt.getTime() - now.getTime();

        if (s.status === 'TRIALING' && left > 0 && left <= 3 * DAY && !s.cancelledAt) {
          await this.alertOwners(s.tenantId, `Your free trial ends in ${Math.ceil(left / DAY)} day(s)`, `Choose a plan to keep using ${s.plan.name} features without interruption.`, `TRIAL_ENDING:${s.id}`);
          result.trialReminders++;
          continue;
        }
        if (left > 0) continue;

        if (s.cancelledAt && s.status !== 'PAST_DUE') {
          await this.suspend(s, 'CANCELLED');
          result.ended++;
          continue;
        }
        if (s.status === 'TRIALING') {
          await this.db.tenantSubscription.updateMany({ where: { id: s.id, status: 'TRIALING' }, data: { status: 'PAST_DUE' } });
          await this.alertOwners(s.tenantId, 'Your free trial has ended', `Pick a plan within ${env().SUBSCRIPTION_GRACE_DAYS} days to keep your account active.`, `TRIAL_ENDED:${s.id}`);
          result.trialsEnded++;
          continue;
        }
        if (s.status === 'ACTIVE') {
          if (s.provider === 'mock' || !s.provider) {
            const end = addCycle(endsAt, s.billingCycle);
            await this.db.$transaction([
              this.db.subscriptionInvoice.create({ data: { tenantId: s.tenantId, subscriptionId: s.id, amount: planPrice(s.plan, s.billingCycle), status: 'PAID', periodStart: endsAt, periodEnd: end, paidAt: now, providerPaymentId: `mock_renew_${s.id}_${endsAt.getTime()}` } }),
              this.db.tenantSubscription.update({ where: { id: s.id }, data: { renewalDate: end } }),
            ]);
            result.renewed++;
          } else if (-left > DAY) {
            await this.db.tenantSubscription.update({ where: { id: s.id }, data: { status: 'PAST_DUE' } });
            await this.alertOwners(s.tenantId, 'Subscription payment overdue', 'We could not collect your renewal payment. Update your payment method to avoid interruption.', `PAST_DUE:${s.id}:${endsAt.toISOString().slice(0, 10)}`);
            result.pastDue++;
          }
          continue;
        }
        if (s.status === 'PAST_DUE' && -left > grace) {
          await this.suspend(s, 'EXPIRED');
          result.suspended++;
        }
      } catch (e) {
        this.logger.error(`Lifecycle failed for subscription ${s.id}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /** Recurring revenue from current paid subscriptions (annual plans are spread over 12 months). */
  async mrr() {
    const subs = await this.db.tenantSubscription.findMany({ where: { isCurrent: true, status: { in: ['ACTIVE', 'PAST_DUE'] } }, include: { plan: true } });
    return round2(subs.reduce((s, x) => s + (x.billingCycle === 'ANNUAL' ? planPrice(x.plan, 'ANNUAL') / 12 : planPrice(x.plan, 'MONTHLY')), 0));
  }
}
