import { Logger } from '@nestjs/common';
import { FeedbackSource, NotificationChannel, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { RetentionService } from '../modules/retention/retention.service';
import { SettingsService } from '../core/settings.service';
import { AuthzService } from '../core/authz.service';
import { rng } from './demo-operations';
import type { DemoContext } from './demo';

const logger = new Logger('SeedDemo');

const COMMENTS: Record<number, string[]> = {
  5: [
    'Absolutely relaxing, the best massage I have had in Bangalore.',
    'Therapist was very skilled and attentive. Will be back!',
    'Loved the ambience and the herbal oil. Felt brand new.',
    'Perfect pressure, super clean rooms.',
    'Booked again for next week already!',
  ],
  4: ['Very good session, the room was a little warm.', 'Great therapist, waited 10 minutes at reception though.', 'Nice experience, would love more music options.'],
  3: ['Session was okay, felt a bit rushed at the end.', 'Average. Expected more for the price.'],
  2: ['Therapist arrived late and the session was cut short.', 'Room was noisy, could hear the reception.'],
  1: ['Very disappointed, the oil was too cold and nobody checked on me.'],
};

function pickRating(r: ReturnType<typeof rng>) {
  const x = r.next();
  return x < 0.55 ? 5 : x < 0.83 ? 4 : x < 0.93 ? 3 : x < 0.98 ? 2 : 1;
}

/**
 * Growth data on top of the operational history: customer feedback for past sessions, WhatsApp
 * enabled with Google review links, retention metrics, campaigns whose conversions come from real
 * invoices inside the attribution window, a delivery log and a few in-app staff alerts.
 */
export async function seedGrowth(ctx: DemoContext) {
  const { db, tenantId, app } = ctx;
  const r = rng(4242);
  const tz = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone ?? 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);

  await app.get(SettingsService).setMany(tenantId, { WHATSAPP_ENABLED: true, CAMPAIGN_ATTRIBUTION_DAYS: 14 });
  for (const b of ctx.branches) {
    await db.branch.update({ where: { id: b.id }, data: { googleReviewUrl: `https://g.page/r/serenity-${b.code.toLowerCase()}/review` } });
  }

  // ---- Feedback on ~65% of completed sessions ----
  const sessions = await db.therapySession.findMany({
    where: { status: 'COMPLETED', completedAt: { not: null } },
    select: { id: true, branchId: true, customerId: true, therapistId: true, completedAt: true },
    orderBy: { completedAt: 'asc' },
  });
  const feedbackRows: Prisma.FeedbackCreateManyInput[] = [];
  for (const s of sessions) {
    if (!r.chance(0.65)) continue;
    const rating = pickRating(r);
    const source: FeedbackSource = r.pick(['IN_APP', 'IN_APP', 'IN_APP', 'QR', 'WHATSAPP', 'MANUAL'] as const);
    feedbackRows.push({
      tenantId,
      branchId: s.branchId,
      customerId: s.customerId,
      sessionId: s.id,
      therapistId: s.therapistId,
      rating,
      comment: r.chance(rating <= 3 ? 0.9 : 0.45) ? r.pick(COMMENTS[rating]) : null,
      source,
      createdAt: new Date(s.completedAt!.getTime() + r.int(20, 300) * 60_000),
    });
  }
  // A handful of walk-up QR ratings without a linked visit.
  for (let i = 0; i < 12; i++) {
    const rating = pickRating(r);
    feedbackRows.push({
      tenantId,
      branchId: r.pick(ctx.branches).id,
      rating,
      comment: r.chance(0.5) ? r.pick(COMMENTS[rating]) : null,
      source: 'QR',
      createdAt: now.minus({ days: r.int(1, 80), hours: r.int(0, 10) }).toJSDate(),
    });
  }
  await db.feedback.createMany({ data: feedbackRows, skipDuplicates: true });
  await db.feedbackRequest.updateMany({ where: { sessionId: { in: feedbackRows.map((f) => f.sessionId).filter((x): x is string => !!x) }, usedAt: null }, data: { usedAt: new Date() } });

  // ---- Retention metrics (segments drift with time) ----
  await app.get(RetentionService).recomputeAll();

  // ---- Campaigns ----
  const optedIn = await db.customer.findMany({ where: { marketingOptIn: true, status: 'ACTIVE' }, select: { id: true, name: true, phone: true, email: true, metrics: { select: { segment: true } } } });
  const flat250 = await db.coupon.findFirst({ where: { code: 'FLAT250' } });
  const welcome = await db.coupon.findFirst({ where: { code: 'WELCOME10' } });
  const owner = ctx.ownerId;

  const makeCampaign = async (c: {
    name: string;
    channel: NotificationChannel;
    body: string;
    subject?: string;
    segment?: 'AT_RISK' | 'INACTIVE' | 'VIP' | 'LOYAL' | null;
    filters?: Record<string, unknown>;
    couponId?: string | null;
    sentDaysAgo?: number;
    scheduledInDays?: number;
    audience?: typeof optedIn;
  }) => {
    const sentAt = c.sentDaysAgo !== undefined ? now.minus({ days: c.sentDaysAgo }).set({ hour: 11, minute: 0 }).toJSDate() : null;
    const campaign = await db.campaign.create({
      data: {
        tenantId,
        name: c.name,
        channel: c.channel,
        templateBody: c.body,
        subject: c.subject ?? null,
        segment: c.segment ?? null,
        filters: (c.filters ?? {}) as Prisma.InputJsonValue,
        couponId: c.couponId ?? null,
        status: sentAt ? 'COMPLETED' : c.scheduledInDays ? 'SCHEDULED' : 'DRAFT',
        scheduledAt: c.scheduledInDays ? now.plus({ days: c.scheduledInDays }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate() : sentAt,
        startedAt: sentAt,
        completedAt: sentAt ? new Date(sentAt.getTime() + 4 * 60_000) : null,
        createdBy: owner,
        createdAt: sentAt ? new Date(sentAt.getTime() - 2 * 86_400_000) : new Date(),
      },
    });
    if (!sentAt || !c.audience) return campaign;
    const windowEnd = new Date(sentAt.getTime() + 14 * 86_400_000);
    for (const cust of c.audience) {
      const invoice = await db.invoice.findFirst({
        where: { customerId: cust.id, status: 'PAID', paidAt: { gt: sentAt, lte: windowEnd } },
        orderBy: { paidAt: 'asc' },
        select: { id: true, total: true, paidAt: true },
      });
      const failed = r.chance(0.04);
      const recipient = await db.campaignRecipient.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          customerId: cust.id,
          status: failed ? 'FAILED' : invoice ? 'CONVERTED' : 'SENT',
          sentAt: failed ? null : new Date(sentAt.getTime() + r.int(0, 180) * 1000),
          convertedAt: !failed && invoice ? invoice.paidAt : null,
          convertedInvoiceId: !failed && invoice ? invoice.id : null,
          revenue: !failed && invoice ? invoice.total : 0,
        },
      });
      const body = c.body
        .replace(/\{\{\s*customer_name\s*\}\}/g, cust.name.split(' ')[0])
        .replace(/\{\{\s*business_name\s*\}\}/g, 'Serenity Wellness')
        .replace(/\{\{\s*offer_code\s*\}\}/g, (c.couponId === flat250?.id ? flat250?.code : welcome?.code) ?? '');
      await db.notificationLog.create({
        data: {
          tenantId,
          customerId: cust.id,
          event: 'MARKETING',
          channel: c.channel,
          recipient: c.channel === 'EMAIL' ? (cust.email ?? '') : cust.phone,
          subject: c.subject ?? null,
          body,
          status: failed ? 'FAILED' : 'SENT',
          error: failed ? 'Recipient is not a WhatsApp user' : null,
          provider: c.channel === 'WHATSAPP' ? 'mock-whatsapp' : c.channel === 'SMS' ? 'mock-sms' : 'mock-email',
          providerMessageId: failed ? null : `mock_${recipient.id}`,
          campaignId: campaign.id,
          refType: 'Campaign',
          refId: campaign.id,
          dedupeKey: `${tenantId}:campaign:${campaign.id}:${cust.id}:${c.channel}`,
          attempts: failed ? 3 : 1,
          createdAt: recipient.sentAt ?? sentAt,
          sentAt: recipient.sentAt,
        },
      });
    }
    return campaign;
  };

  await makeCampaign({
    name: 'Monsoon wellness: ₹250 off',
    channel: 'WHATSAPP',
    body: 'Hi {{customer_name}}, beat the monsoon blues at {{business_name}}! Enjoy ₹250 off any therapy above ₹1500 with code {{offer_code}}. Book: {{booking_link}}',
    couponId: flat250?.id,
    sentDaysAgo: 40,
    audience: optedIn,
  });
  const lapsed = optedIn.filter((c) => ['AT_RISK', 'INACTIVE', 'CHURNED'].includes(c.metrics?.segment ?? ''));
  await makeCampaign({
    name: 'We miss you: win-back',
    channel: 'SMS',
    body: 'Hi {{customer_name}}, we miss you at {{business_name}}! Here is 10% off your next visit with code {{offer_code}}.',
    segment: 'INACTIVE',
    couponId: welcome?.id,
    sentDaysAgo: 12,
    audience: lapsed.length ? lapsed : optedIn.slice(0, 6),
  });
  await makeCampaign({
    name: 'Birthday month treat',
    channel: 'EMAIL',
    subject: 'A birthday treat from {{business_name}}',
    body: '<p>Happy birthday month, {{customer_name}}!</p><p>Enjoy 10% off any therapy this month with code <b>{{offer_code}}</b>.</p>',
    filters: { birthdayThisMonth: true },
    couponId: welcome?.id,
  });
  await makeCampaign({
    name: 'Diwali glow facial offer',
    channel: 'WHATSAPP',
    body: 'Hi {{customer_name}}, get festival-ready with our Diwali glow facial at {{business_name}}. Limited slots, book now: {{booking_link}}',
    segment: 'VIP',
    scheduledInDays: 10,
  });

  // ---- Transactional delivery log for recent activity ----
  const logs: Prisma.NotificationLogCreateManyInput[] = [];
  const upcoming = await db.appointment.findMany({ where: { startTime: { gt: new Date() }, status: { in: ['BOOKED', 'CONFIRMED'] } }, include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } }, branch: { select: { name: true } } } });
  for (const a of upcoming) {
    logs.push({
      tenantId,
      customerId: a.customerId,
      event: 'APPOINTMENT_BOOKED',
      channel: 'WHATSAPP',
      recipient: a.customer.phone,
      body: `Hi ${a.customer.name.split(' ')[0]}, your appointment at ${a.branch.name} is confirmed for ${DateTime.fromJSDate(a.startTime).setZone(tz).toFormat('ccc, dd LLL, h:mm a')}.\nService: ${a.service.name}`,
      status: 'SENT',
      provider: 'mock-whatsapp',
      providerMessageId: `wamid.mock_${a.id}`,
      refType: 'Appointment',
      refId: a.id,
      dedupeKey: `${tenantId}:APPOINTMENT_BOOKED:Appointment:${a.id}:WHATSAPP`,
      attempts: 1,
      createdAt: a.createdAt,
      sentAt: a.createdAt,
    });
  }
  const payments = await db.payment.findMany({
    where: { status: 'SUCCESS', paidAt: { gte: now.minus({ days: 7 }).toJSDate() }, customerId: { not: null } },
    include: { invoice: { select: { invoiceNumber: true, customer: { select: { name: true, phone: true } } } } },
  });
  for (const p of payments) {
    if (!p.invoice.customer) continue;
    logs.push({
      tenantId,
      customerId: p.customerId,
      event: 'PAYMENT_RECEIVED',
      channel: 'WHATSAPP',
      recipient: p.invoice.customer.phone,
      body: `Payment of ₹${Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })} received for invoice ${p.invoice.invoiceNumber}. Thank you, ${p.invoice.customer.name.split(' ')[0]}!`,
      status: 'SENT',
      provider: 'mock-whatsapp',
      providerMessageId: `wamid.mock_${p.id}`,
      refType: 'Payment',
      refId: p.id,
      dedupeKey: `${tenantId}:PAYMENT_RECEIVED:Payment:${p.id}:WHATSAPP`,
      attempts: 1,
      createdAt: p.paidAt!,
      sentAt: p.paidAt,
    });
  }
  await db.notificationLog.createMany({ data: logs, skipDuplicates: true });

  // ---- In-app alerts for staff ----
  const authz = app.get(AuthzService);
  const users = await db.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  const alerts: Array<{ perm: string; branchId?: string; type: string; title: string; body: string; link: string; hoursAgo: number }> = [];
  const low = await db.$queryRaw<{ branchId: string; productId: string; name: string; unit: string; quantity: number; reorderLevel: number; branch: string }[]>`
    SELECT s."branchId", s."productId", p.name, p.unit, s.quantity::float AS quantity, s."reorderLevel"::float AS "reorderLevel", b.name AS branch
    FROM inventory_stock s JOIN products p ON p.id = s."productId" JOIN branches b ON b.id = s."branchId"
    WHERE s."tenantId" = ${tenantId} AND s.quantity <= s."reorderLevel" AND s."reorderLevel" > 0`;
  low.forEach((l, i) =>
    alerts.push({
      perm: 'inventory.purchase',
      branchId: l.branchId,
      type: 'STOCK_LOW',
      title: `Low stock: ${l.name}`,
      body: `${l.quantity} ${l.unit} left at ${l.branch} (reorder level ${l.reorderLevel}).`,
      link: `/inventory?lowStock=true&branchId=${l.branchId}`,
      hoursAgo: 3 + i * 5,
    }),
  );
  const lowFb = await db.feedback.findFirst({ where: { rating: { lte: 2 }, customerId: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (lowFb) {
    const cust = await db.customer.findFirst({ where: { id: lowFb.customerId! }, select: { name: true } });
    alerts.push({
      perm: 'feedback.manage',
      branchId: lowFb.branchId,
      type: 'LOW_RATING',
      title: `${lowFb.rating}★ feedback from ${cust?.name ?? 'a customer'}`,
      body: lowFb.comment ?? 'No comment left. Consider calling the customer.',
      link: `/feedback?maxRating=2&highlight=${lowFb.id}`,
      hoursAgo: 20,
    });
  }
  alerts.push({ perm: 'reports.financial', type: 'DAILY_SUMMARY', title: `Yesterday (${now.minus({ days: 1 }).toFormat('dd LLL')}) at a glance`, body: 'Open the sales report for yesterday’s billing, collections and sessions.', link: '/reports?report=sales', hoursAgo: 2 });
  let inApp = 0;
  for (const u of users) {
    const a = await authz.getUserAuthz(u.id);
    if (!a) continue;
    for (const al of alerts) {
      if (!a.permissions.includes(al.perm)) continue;
      if (al.branchId && !a.allBranches && !a.branchIds.includes(al.branchId)) continue;
      await db.inAppNotification.create({
        data: { tenantId, userId: u.id, branchId: al.branchId ?? null, type: al.type, title: al.title, body: al.body, link: al.link, createdAt: now.minus({ hours: al.hoursAgo }).toJSDate() },
      });
      inApp++;
    }
  }
  logger.log(`Growth: ${feedbackRows.length} feedback, 4 campaigns, ${logs.length} notification logs, ${inApp} in-app alerts`);
}
