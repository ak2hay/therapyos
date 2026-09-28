import { Injectable, Logger } from '@nestjs/common';
import { CampaignStatus, CustomerSegment, NotificationChannel, Prisma } from '@prisma/client';
import { CampaignAudienceInput, CampaignInput } from '@therapyos/validation';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { OnDomainEvent } from '../../jobs/event-handlers';
import { NotificationsService } from '../notifications/notifications.service';
import { templateError } from '../notifications/template-renderer';

type Filters = CampaignInput['filters'];
const BATCH = 200;
/** Sends up to this many recipients during the API request; larger audiences continue in the scheduler. */
const INLINE_LIMIT = 500;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolves the audience. Only active customers who opted in to marketing are ever included
   * (DPDP consent); the email channel additionally needs an address on file.
   */
  private async audienceWhere(segment: string | undefined | null, filters: Filters, channel: string): Promise<Prisma.CustomerWhereInput> {
    const tenantId = RequestContext.requireTenantId();
    const and: Prisma.CustomerWhereInput[] = [{ status: 'ACTIVE' }, { marketingOptIn: true }];
    if (channel === 'EMAIL') and.push({ email: { not: null } });
    if (segment) and.push({ metrics: { segment: segment as CustomerSegment } });
    const f = filters ?? {};
    if (f.branchId) and.push({ OR: [{ primaryBranchId: f.branchId }, { sessions: { some: { branchId: f.branchId } } }] });
    if (f.firstTimeVisitors) and.push({ metrics: { visitCount: 1 } });
    if (f.minLifetimeValue) and.push({ metrics: { lifetimeValue: { gte: f.minLifetimeValue } } });
    const now = new Date();
    if (f.packageExpiringInDays) and.push({ packages: { some: { status: 'ACTIVE', expiresAt: { gte: now, lte: new Date(now.getTime() + f.packageExpiringInDays * 86_400_000) } } } });
    if (f.membershipExpiringInDays) and.push({ memberships: { some: { status: 'ACTIVE', expiresAt: { gte: now, lte: new Date(now.getTime() + f.membershipExpiringInDays * 86_400_000) } } } });
    if (f.birthdayThisMonth) {
      const tz = await this.settings.timezone(tenantId);
      const month = DateTime.now().setZone(tz).month;
      const rows = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM customers WHERE "tenantId" = ${tenantId} AND dob IS NOT NULL AND EXTRACT(MONTH FROM dob) = ${month}`;
      and.push({ id: { in: rows.map((r) => r.id) } });
    }
    return { AND: and };
  }

  async audience(input: CampaignAudienceInput) {
    const where = await this.audienceWhere(input.segment, input.filters, input.channel);
    // Same filters minus the consent clause, to show how many were excluded for lack of opt-in.
    const withoutConsent = { AND: (where.AND as Prisma.CustomerWhereInput[]).filter((c) => !('marketingOptIn' in c)) };
    const [count, sample, eligible] = await Promise.all([
      this.db.customer.count({ where }),
      this.db.customer.findMany({ where, take: 8, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, phone: true, email: true, metrics: { select: { segment: true, lifetimeValue: true, lastVisitAt: true } } } }),
      this.db.customer.count({ where: withoutConsent }),
    ]);
    return { count, sample, excludedNoConsent: Math.max(0, eligible - count) };
  }

  private async stats(campaignIds: string[]) {
    if (!campaignIds.length) return new Map<string, { total: number; sent: number; failed: number; skipped: number; pending: number; converted: number; revenue: number }>();
    const rows = await this.db.campaignRecipient.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: campaignIds } }, _count: { _all: true }, _sum: { revenue: true } });
    const map = new Map<string, { total: number; sent: number; failed: number; skipped: number; pending: number; converted: number; revenue: number }>();
    for (const id of campaignIds) map.set(id, { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0, converted: 0, revenue: 0 });
    for (const r of rows) {
      const s = map.get(r.campaignId)!;
      s.total += r._count._all;
      if (r.status === 'SENT') s.sent += r._count._all;
      if (r.status === 'CONVERTED') {
        s.converted += r._count._all;
        s.sent += r._count._all;
        s.revenue = round2(s.revenue + num(r._sum.revenue));
      }
      if (r.status === 'FAILED') s.failed += r._count._all;
      if (r.status === 'SKIPPED') s.skipped += r._count._all;
      if (r.status === 'PENDING') s.pending += r._count._all;
    }
    return map;
  }

  async list(q: { page: number; pageSize: number; status?: string; search?: string }) {
    const where: Prisma.CampaignWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as CampaignStatus[] };
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' };
    const [items, total] = await Promise.all([
      this.db.campaign.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.campaign.count({ where }),
    ]);
    const stats = await this.stats(items.map((i) => i.id));
    const result = paged(
      items.map((c) => ({ ...c, stats: stats.get(c.id)! })),
      total,
      q,
    );
    const all = await this.db.campaignRecipient.aggregate({ where: { status: 'CONVERTED' }, _sum: { revenue: true }, _count: { _all: true } });
    const sent = await this.db.campaignRecipient.count({ where: { status: { in: ['SENT', 'CONVERTED'] } } });
    Object.assign(result.meta, { summary: { sent, converted: all._count._all, revenue: num(all._sum.revenue), conversionRate: sent ? round2((all._count._all / sent) * 100) : 0 } });
    return result;
  }

  async get(id: string) {
    const c = await this.db.campaign.findFirst({ where: { id } });
    if (!c) throw AppError.notFound('Campaign');
    const [stats, coupon, offer, recent] = await Promise.all([
      this.stats([id]),
      c.couponId ? this.db.coupon.findFirst({ where: { id: c.couponId }, select: { id: true, code: true } }) : null,
      c.offerId ? this.db.offer.findFirst({ where: { id: c.offerId }, select: { id: true, name: true } }) : null,
      this.db.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: [{ convertedAt: { sort: 'desc', nulls: 'last' } }, { sentAt: { sort: 'desc', nulls: 'last' } }], take: 50 }),
    ]);
    const customers = await this.db.customer.findMany({ where: { id: { in: recent.map((r) => r.customerId) } }, select: { id: true, name: true, phone: true } });
    const byId = new Map(customers.map((x) => [x.id, x]));
    return { ...c, stats: stats.get(id)!, coupon, offer, recipients: recent.map((r) => ({ ...r, customer: byId.get(r.customerId) ?? null })) };
  }

  private validateBody(input: Partial<CampaignInput>) {
    const err = templateError(input.templateBody ?? '') ?? templateError(input.subject ?? '');
    if (err) throw AppError.validation(`Message template is invalid: ${err}`, { fields: { templateBody: err } });
    if (input.channel === 'EMAIL' && input.subject === undefined) throw AppError.validation('Email campaigns need a subject.', { fields: { subject: 'Required for email' } });
  }

  private async assertRefs(input: Partial<CampaignInput>) {
    if (input.couponId && !(await this.db.coupon.findFirst({ where: { id: input.couponId }, select: { id: true } }))) throw AppError.notFound('Coupon');
    if (input.offerId && !(await this.db.offer.findFirst({ where: { id: input.offerId }, select: { id: true } }))) throw AppError.notFound('Offer');
  }

  async create(input: CampaignInput) {
    this.validateBody(input);
    await this.assertRefs(input);
    const tenantId = RequestContext.requireTenantId();
    const c = await this.db.campaign.create({
      data: {
        tenantId,
        name: input.name,
        segment: (input.segment as CustomerSegment | undefined) ?? null,
        filters: (input.filters ?? {}) as Prisma.InputJsonValue,
        channel: input.channel as NotificationChannel,
        subject: input.subject ?? null,
        templateBody: input.templateBody,
        offerId: input.offerId ?? null,
        couponId: input.couponId ?? null,
        status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT',
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        createdBy: RequestContext.userId ?? null,
      },
    });
    await this.audit.log({ action: 'CAMPAIGN_CREATED', entityType: 'Campaign', entityId: c.id, newValues: input });
    return this.get(c.id);
  }

  async update(id: string, input: Partial<CampaignInput>) {
    const before = await this.get(id);
    if (!['DRAFT', 'SCHEDULED'].includes(before.status)) throw AppError.invalidState(`A ${before.status.toLowerCase()} campaign cannot be edited.`);
    this.validateBody({ channel: before.channel as CampaignInput['channel'], subject: before.subject ?? undefined, templateBody: before.templateBody, ...input });
    await this.assertRefs(input);
    await this.db.campaign.update({
      where: { id },
      data: {
        name: input.name,
        segment: input.segment === undefined ? undefined : ((input.segment as CustomerSegment) ?? null),
        filters: input.filters === undefined ? undefined : (input.filters as Prisma.InputJsonValue),
        channel: input.channel as NotificationChannel | undefined,
        subject: input.subject,
        templateBody: input.templateBody,
        offerId: input.offerId,
        couponId: input.couponId,
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT' } : {}),
      },
    });
    await this.audit.log({ action: 'CAMPAIGN_UPDATED', entityType: 'Campaign', entityId: id, newValues: input });
    return this.get(id);
  }

  async remove(id: string) {
    const c = await this.get(id);
    if (c.status !== 'DRAFT' && c.status !== 'CANCELLED') throw AppError.invalidState('Only draft or cancelled campaigns can be deleted.');
    await this.db.campaign.delete({ where: { id } });
    await this.audit.log({ action: 'CAMPAIGN_DELETED', entityType: 'Campaign', entityId: id, oldValues: { name: c.name } });
    return { deleted: true };
  }

  async schedule(id: string, scheduledAt?: string) {
    const c = await this.get(id);
    if (!['DRAFT', 'SCHEDULED'].includes(c.status)) throw AppError.invalidState(`A ${c.status.toLowerCase()} campaign cannot be scheduled.`);
    if (scheduledAt && new Date(scheduledAt) < new Date(Date.now() - 60_000)) throw AppError.validation('Schedule time must be in the future.', { fields: { scheduledAt: 'Must be in the future' } });
    await this.db.campaign.update({ where: { id }, data: { status: scheduledAt ? 'SCHEDULED' : 'DRAFT', scheduledAt: scheduledAt ? new Date(scheduledAt) : null } });
    await this.audit.log({ action: scheduledAt ? 'CAMPAIGN_SCHEDULED' : 'CAMPAIGN_UNSCHEDULED', entityType: 'Campaign', entityId: id, newValues: { scheduledAt } });
    return this.get(id);
  }

  async cancel(id: string) {
    const c = await this.get(id);
    if (!['DRAFT', 'SCHEDULED', 'RUNNING'].includes(c.status)) throw AppError.invalidState(`A ${c.status.toLowerCase()} campaign cannot be cancelled.`);
    await this.db.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
      await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    });
    await this.audit.log({ action: 'CAMPAIGN_CANCELLED', entityType: 'Campaign', entityId: id });
    return this.get(id);
  }

  /** Starts a campaign now: snapshots the audience, then sends (inline for small audiences). */
  async send(id: string) {
    const c = await this.get(id);
    if (!['DRAFT', 'SCHEDULED'].includes(c.status)) throw AppError.invalidState(`A ${c.status.toLowerCase()} campaign cannot be sent.`);
    const recipients = await this.start(id);
    if (!recipients) {
      await this.db.campaign.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      throw AppError.invalidState('No customers match this audience (only customers who opted in to marketing are included).');
    }
    await this.audit.log({ action: 'CAMPAIGN_SENT', entityType: 'Campaign', entityId: id, newValues: { recipients } });
    if (recipients <= INLINE_LIMIT) await this.process(id, INLINE_LIMIT);
    return this.get(id);
  }

  private async start(id: string) {
    const tenantId = RequestContext.requireTenantId();
    // Claim atomically so a manual send and the scheduler can never both start it.
    const claimed = await this.db.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) return 0;
    const c = (await this.db.campaign.findFirst({ where: { id } }))!;
    const where = await this.audienceWhere(c.segment, (c.filters ?? {}) as Filters, c.channel);
    const customers = await this.db.customer.findMany({ where, select: { id: true } });
    for (let i = 0; i < customers.length; i += 1000) {
      await this.db.campaignRecipient.createMany({ data: customers.slice(i, i + 1000).map((x) => ({ tenantId, campaignId: id, customerId: x.id })), skipDuplicates: true });
    }
    return customers.length;
  }

  /** Sends pending recipients in batches; marks the campaign completed when none remain. */
  async process(id: string, limit = BATCH) {
    const c = await this.db.campaign.findFirst({ where: { id } });
    if (!c || c.status !== 'RUNNING') return 0;
    const coupon = c.couponId ? await this.db.coupon.findFirst({ where: { id: c.couponId }, select: { code: true } }) : null;
    let done = 0;
    while (done < limit) {
      const batch = await this.db.campaignRecipient.findMany({ where: { campaignId: id, status: 'PENDING' }, take: Math.min(BATCH, limit - done) });
      if (!batch.length) break;
      for (const r of batch) {
        let status: 'SENT' | 'SKIPPED' | 'FAILED' = 'SKIPPED';
        try {
          const res = await this.notifications.notifyCustomer(
            'MARKETING',
            r.customerId,
            { offer_code: coupon?.code ?? '' },
            { campaignId: id, channels: [c.channel as 'SMS' | 'EMAIL' | 'WHATSAPP'], bodyOverride: c.templateBody, subjectOverride: c.subject ?? undefined, refType: 'Campaign', refId: id, dedupeKey: `campaign:${id}:${r.customerId}` },
          );
          status = res.queued > 0 ? 'SENT' : 'SKIPPED';
        } catch (e) {
          this.logger.warn(`Campaign ${id} send to ${r.customerId} failed: ${(e as Error).message}`);
          status = 'FAILED';
        }
        await this.db.campaignRecipient.update({ where: { id: r.id }, data: { status, sentAt: status === 'SENT' ? new Date() : null } });
        done++;
      }
    }
    const pending = await this.db.campaignRecipient.count({ where: { campaignId: id, status: 'PENDING' } });
    if (!pending) await this.db.campaign.updateMany({ where: { id, status: 'RUNNING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    return done;
  }

  /** Scheduler tick: start due scheduled campaigns and continue running ones. */
  async dispatchDue() {
    const due = await this.db.campaign.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, select: { id: true } });
    for (const c of due) await this.start(c.id);
    const running = await this.db.campaign.findMany({ where: { status: 'RUNNING' }, select: { id: true } });
    let sent = 0;
    for (const c of running) sent += await this.process(c.id);
    return { started: due.length, sent };
  }

  /**
   * Attribution: a paid invoice converts the campaign whose coupon was redeemed, otherwise the most
   * recent campaign message within the attribution window (last touch). One conversion per recipient.
   */
  @OnDomainEvent('invoice.paid')
  async attribute(p: Record<string, any>) {
    if (!p.customerId) return;
    const tenantId = RequestContext.requireTenantId();
    const windowDays = Number((await this.settings.get<number>(tenantId, 'CAMPAIGN_ATTRIBUTION_DAYS')) ?? 14);
    const paidAt = p.paidAt ? new Date(p.paidAt) : new Date();
    const invoice = await this.db.invoice.findFirst({ where: { id: p.invoiceId }, select: { couponId: true, total: true } });
    if (!invoice) return;
    const already = await this.db.campaignRecipient.findFirst({ where: { convertedInvoiceId: p.invoiceId } });
    if (already) return already;
    const base: Prisma.CampaignRecipientWhereInput = {
      customerId: p.customerId,
      status: 'SENT',
      sentAt: { gte: new Date(paidAt.getTime() - windowDays * 86_400_000), lte: paidAt },
    };
    const recipient =
      (invoice.couponId ? await this.db.campaignRecipient.findFirst({ where: { ...base, campaign: { couponId: invoice.couponId } }, orderBy: { sentAt: 'desc' } }) : null) ??
      (await this.db.campaignRecipient.findFirst({ where: base, orderBy: { sentAt: 'desc' } }));
    if (!recipient) return;
    return this.db.campaignRecipient.updateMany({
      where: { id: recipient.id, status: 'SENT' },
      data: { status: 'CONVERTED', convertedAt: paidAt, convertedInvoiceId: p.invoiceId, revenue: num(invoice.total) },
    });
  }
}
