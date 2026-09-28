import { INestApplicationContext, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Db, DB } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { dateOnly } from '../common/utils/dates';
import { FranchiseService } from '../modules/franchise/franchise.service';
import { addCycle, planPrice } from '../modules/subscription/subscription.service';
import { ProvisioningService } from '../modules/tenants/provisioning.service';
import type { DemoContext } from './demo';

const logger = new Logger('SeedScale');

/** Franchise, branding, support and subscription history for the demo tenant (M7). */
export async function seedScale(ctx: DemoContext) {
  const { db, tenantId, app } = ctx;
  const tz = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone ?? 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);
  const kor = ctx.branches.find((b) => b.code === 'KOR');

  await db.tenantBranding.upsert({
    where: { tenantId },
    create: { tenantId, appName: 'Serenity Wellness', emailSenderName: 'Serenity Wellness', whatsappDisplayName: 'Serenity Wellness', invoiceFooter: 'Thank you for choosing Serenity. Relax, restore, return.', poweredBy: true },
    update: {},
  });

  // ---- Franchise: Koramangala is run by a franchise partner ----
  if (kor && !(await db.franchiseGroup.count())) {
    const franchise = app.get(FranchiseService);
    const group = await franchise.createGroup({ name: 'Serenity Partners South', description: 'Franchise partners across Karnataka and Tamil Nadu', status: 'ACTIVE' });
    const partner = await franchise.create({
      franchiseGroupId: group.id,
      name: 'Koramangala Wellness LLP',
      ownerName: 'Vikram Rao',
      email: 'vikram@kwellness.demo',
      phone: '+919811100001',
      status: 'ACTIVE',
      branchIds: [kor.id],
    });
    await franchise.createContract({
      franchiseeId: partner.id,
      startDate: now.minus({ months: 8 }).startOf('month').toISODate()!,
      endDate: now.plus({ years: 4 }).endOf('month').toISODate()!,
      royaltyPercent: 6,
      marketingFeePercent: 2,
      fixedMonthlyFee: 5000,
      franchiseFee: 250000,
      terms: 'Five-year franchise. Royalty and marketing fees on net sales (ex tax), payable by the 15th of the following month.',
      status: 'ACTIVE',
    });
    await franchise.createGroup({ name: 'Serenity Partners West', description: 'Pune and Mumbai expansion (pipeline)', status: 'ACTIVE' });
    for (let m = 3; m >= 1; m--) await franchise.runRoyalties(now.minus({ months: m }).toFormat('yyyy-LL'));
    // Older periods and the joining fee are settled; last month's fees are still due.
    const lastMonth = dateOnly(now.minus({ months: 1 }).startOf('month').toISODate()!);
    await db.franchiseFee.updateMany({ where: { periodStart: { lt: lastMonth } }, data: { status: 'PAID', paidAt: now.minus({ days: 20 }).toJSDate() } });
  }

  // ---- Support tickets ----
  if (!(await db.supportTicket.count())) {
    const owner = await db.user.findFirstOrThrow({ where: { id: ctx.ownerId } });
    const resolved = await db.supportTicket.create({
      data: {
        tenantId,
        createdByUserId: owner.id,
        subject: 'WhatsApp reminders not reaching some customers',
        description: 'A few customers say they did not get the reminder message for their appointment yesterday.',
        priority: 'HIGH',
        status: 'RESOLVED',
        createdAt: now.minus({ days: 9 }).toJSDate(),
      },
    });
    await db.supportTicketMessage.createMany({
      data: [
        { tenantId, ticketId: resolved.id, authorType: 'ADMIN', authorName: 'Rkyves Support', body: 'Thanks for flagging this. Those customers had not opted in to WhatsApp, so reminders went by SMS. You can check each message in Settings > Notifications > Delivery log.', createdAt: now.minus({ days: 8 }).toJSDate() },
        { tenantId, ticketId: resolved.id, authorType: 'USER', authorId: owner.id, authorName: owner.name, body: 'Got it, the delivery log shows the SMS. Thank you!', createdAt: now.minus({ days: 8 }).plus({ hours: 3 }).toJSDate() },
      ],
    });
    await db.supportTicket.create({
      data: {
        tenantId,
        createdByUserId: owner.id,
        subject: 'Can we export GST reports in Tally format?',
        description: 'Our accountant uses Tally. Is there a way to export the tax report in a format Tally can import?',
        priority: 'MEDIUM',
        status: 'OPEN',
        createdAt: now.minus({ days: 1 }).toJSDate(),
      },
    });
  }

  // ---- Subscription invoice history (Enterprise, monthly) ----
  const sub = await db.tenantSubscription.findFirst({ where: { tenantId, isCurrent: true }, include: { plan: true } });
  if (sub && !(await db.subscriptionInvoice.count({ where: { tenantId } }))) {
    for (let m = 5; m >= 0; m--) {
      const start = now.minus({ months: m }).startOf('month').toJSDate();
      await db.subscriptionInvoice.create({
        data: { tenantId, subscriptionId: sub.id, amount: planPrice(sub.plan, 'MONTHLY'), status: 'PAID', periodStart: start, periodEnd: addCycle(start, 'MONTHLY'), paidAt: start, providerPaymentId: `mock_hist_${sub.id}_${m}` },
      });
    }
    await db.tenantSubscription.update({ where: { id: sub.id }, data: { provider: 'mock', startDate: now.minus({ months: 5 }).startOf('month').toJSDate() } });
  }
}

const OTHER_TENANTS: Array<{ slug: string; name: string; owner: string; email: string; phone: string; plan: string; status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED'; cycle?: 'MONTHLY' | 'ANNUAL'; ageDays: number; tenantStatus?: 'ACTIVE' | 'SUSPENDED' | 'ONBOARDING'; months?: number }> = [
  { slug: 'lotus-physio', name: 'Lotus Physiotherapy', owner: 'Dr. Meera Nair', email: 'owner@lotusphysio.demo', phone: '+919822200001', plan: 'GROWTH', status: 'ACTIVE', cycle: 'MONTHLY', ageDays: 150, months: 5 },
  { slug: 'urban-glow-salon', name: 'Urban Glow Salon', owner: 'Farah Khan', email: 'owner@urbanglow.demo', phone: '+919822200002', plan: 'BUSINESS', status: 'ACTIVE', cycle: 'ANNUAL', ageDays: 220, months: 1 },
  { slug: 'mindful-care', name: 'Mindful Care Clinic', owner: 'Dr. Arvind Das', email: 'owner@mindfulcare.demo', phone: '+919822200003', plan: 'STARTER', status: 'ACTIVE', cycle: 'MONTHLY', ageDays: 90, months: 3 },
  { slug: 'zen-spa-goa', name: 'Zen Spa Goa', owner: 'Liam Fernandes', email: 'owner@zenspa.demo', phone: '+919822200004', plan: 'GROWTH', status: 'TRIALING', ageDays: 11, tenantStatus: 'ONBOARDING' },
  { slug: 'fitfix-rehab', name: 'FitFix Rehab', owner: 'Sana Qureshi', email: 'owner@fitfix.demo', phone: '+919822200005', plan: 'STARTER', status: 'PAST_DUE', cycle: 'MONTHLY', ageDays: 75, months: 2 },
  { slug: 'serene-skin', name: 'Serene Skin Studio', owner: 'Pooja Bhatt', email: 'owner@sereneskin.demo', phone: '+919822200006', plan: 'GROWTH', status: 'CANCELLED', cycle: 'MONTHLY', ageDays: 200, months: 4, tenantStatus: 'SUSPENDED' },
];

/** Other businesses on the platform so the Super Admin console has realistic data. Idempotent by slug. */
export async function seedPlatformTenants(app: INestApplicationContext) {
  const db = app.get<Db>(DB);
  const provisioning = app.get(ProvisioningService);
  for (const t of OTHER_TENANTS) {
    if (await db.tenant.findUnique({ where: { slug: t.slug } })) continue;
    const { tenant } = await provisioning.provision({ businessName: t.name, ownerName: t.owner, email: t.email, phone: t.phone, password: 'Demo@12345' });
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: t.plan } });
    const created = new Date(Date.now() - t.ageDays * 86_400_000);
    const status = t.tenantStatus ?? 'ACTIVE';
    await db.tenant.update({
      where: { id: tenant.id },
      data: {
        slug: t.slug,
        createdAt: created,
        status,
        subscriptionPlanId: plan.id,
        ...(status === 'SUSPENDED' ? { suspendedReason: 'Subscription lapsed' } : {}),
        ...(status !== 'ONBOARDING' ? { onboardingCompletedAt: created, onboardingStep: 10 } : {}),
      },
    });
    const sub = await db.tenantSubscription.findFirstOrThrow({ where: { tenantId: tenant.id, isCurrent: true } });
    const cycle = t.cycle ?? 'MONTHLY';
    const lastPeriodStart = t.months ? DateTime.now().startOf('month').minus({ months: t.status === 'ACTIVE' ? 0 : 1 }).toJSDate() : null;
    await db.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        planId: plan.id,
        status: t.status,
        billingCycle: cycle,
        provider: t.status === 'TRIALING' ? null : 'mock',
        startDate: created,
        trialEndDate: t.status === 'TRIALING' ? new Date(Date.now() + 3 * 86_400_000) : null,
        renewalDate: t.status === 'TRIALING' ? new Date(Date.now() + 3 * 86_400_000) : t.status === 'PAST_DUE' ? new Date(Date.now() - 2 * 86_400_000) : lastPeriodStart ? addCycle(lastPeriodStart, cycle) : null,
        cancelledAt: t.status === 'CANCELLED' ? new Date(Date.now() - 20 * 86_400_000) : null,
      },
    });
    for (let m = (t.months ?? 0) - 1; m >= 0; m--) {
      const start = DateTime.now().startOf('month').minus({ months: m + (t.status === 'ACTIVE' ? 0 : 1) }).toJSDate();
      await db.subscriptionInvoice.create({
        data: { tenantId: tenant.id, subscriptionId: sub.id, amount: planPrice(plan, cycle), status: 'PAID', periodStart: start, periodEnd: addCycle(start, cycle), paidAt: start, providerPaymentId: `mock_hist_${sub.id}_${m}` },
      });
    }
    if (t.status === 'PAST_DUE') {
      await db.subscriptionInvoice.create({ data: { tenantId: tenant.id, subscriptionId: sub.id, amount: planPrice(plan, cycle), status: 'FAILED', periodStart: new Date(Date.now() - 2 * 86_400_000), periodEnd: addCycle(new Date(Date.now() - 2 * 86_400_000), cycle) } });
    }
    if (t.slug === 'fitfix-rehab') {
      const owner = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
      await RequestContext.runAsTenant(tenant.id, async () => {
        await db.supportTicket.create({ data: { tenantId: tenant.id, createdByUserId: owner.id, subject: 'Payment failed for renewal', description: 'Our card was declined for the renewal. How do we update the payment method?', priority: 'URGENT', status: 'OPEN' } });
      });
    }
    logger.log(`Platform tenant ${t.slug} (${t.plan}, ${t.status}) created`);
  }
}
