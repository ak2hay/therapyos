import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { DateTime } from 'luxon';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { FeaturesService } from '../../core/features.service';
import { FranchiseService } from '../franchise/franchise.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { formatInZone } from '../../common/utils/dates';
import { num } from '../../common/utils/money';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { bullConnection, QUEUES, QueueService, shouldRunWorkers } from '../../jobs/queue.service';
import { jobCounter } from '../../observability/observability';
import { CampaignsService } from '../campaigns/campaigns.service';
import { MembershipsService } from '../memberships/memberships.service';
import { formatMoney } from '../notifications/notification-handlers';
import { NotificationsService } from '../notifications/notifications.service';
import { PackagesService } from '../packages/packages.service';
import { RetentionService } from '../retention/retention.service';

export const AUTOMATION_JOBS = ['reminders', 'daily', 'campaigns', 'expiry', 'birthdays', 'metrics', 'summary', 'royalties'] as const;
export type AutomationJob = (typeof AUTOMATION_JOBS)[number];

/** Daily jobs run on the first hourly tick at or after this local hour. */
const DAILY_HOUR = 8;
const LAST_DAILY_KEY = 'LAST_DAILY_JOBS';

/**
 * Repeatable jobs (BullMQ job schedulers on the `scheduled` queue). Each tick fans out to every
 * active tenant in its own tenant context; one tenant failing never blocks the others.
 */
@Injectable()
export class AutomationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AutomationService.name);
  private worker?: Worker;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly campaigns: CampaignsService,
    private readonly retention: RetentionService,
    private readonly packages: PackagesService,
    private readonly memberships: MembershipsService,
    private readonly franchise: FranchiseService,
    private readonly subscriptions: SubscriptionService,
    private readonly features: FeaturesService,
  ) {}

  async onApplicationBootstrap() {
    if (!shouldRunWorkers()) return;
    const q = this.queues.queue(QUEUES.SCHEDULED);
    try {
      await q.upsertJobScheduler('reminders', { every: 15 * 60_000 }, { name: 'reminders' });
      await q.upsertJobScheduler('daily-tick', { pattern: '5 * * * *' }, { name: 'daily-tick' });
      await q.upsertJobScheduler('campaigns', { every: 60_000 }, { name: 'campaigns' });
      await q.upsertJobScheduler('subscriptions', { pattern: '15 * * * *' }, { name: 'subscriptions' });
    } catch (e) {
      this.logger.error(`Could not register job schedulers: ${(e as Error).message}`);
    }
    this.worker = new Worker(QUEUES.SCHEDULED, (job) => this.tick(job), { connection: bullConnection(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.warn(`Scheduled job ${job?.name} failed: ${err.message}`));
    this.logger.log('Automation schedulers registered (reminders 15m, daily tick hourly, campaigns 1m, subscriptions hourly)');
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
  }

  private async tick(job: Job) {
    if (job.name === 'subscriptions') {
      const result = await this.subscriptions.lifecycle();
      jobCounter.inc({ queue: QUEUES.SCHEDULED, name: 'subscriptions', result: 'success' });
      return result;
    }
    const name = job.name === 'daily-tick' ? 'daily' : (job.name as AutomationJob);
    const tenants = await this.db.tenant.findMany({ where: { status: { in: ['ACTIVE', 'ONBOARDING'] } }, select: { id: true } });
    let failures = 0;
    for (const t of tenants) {
      try {
        await RequestContext.runAsTenant(t.id, () => this.run(name), { requestId: `cron_${name}_${t.id}` });
      } catch (e) {
        failures++;
        this.logger.error(`Job ${name} failed for tenant ${t.id}: ${(e as Error).message}`);
      }
    }
    jobCounter.inc({ queue: QUEUES.SCHEDULED, name, result: failures ? 'failure' : 'success' });
  }

  /** Runs one job for the current tenant. `force` bypasses the once-a-day guard (manual trigger). */
  async run(name: AutomationJob, opts: { force?: boolean } = {}): Promise<Record<string, unknown>> {
    switch (name) {
      case 'reminders':
        return this.reminders();
      case 'campaigns':
        return this.campaigns.dispatchDue();
      case 'daily':
        return this.daily(opts.force);
      case 'expiry':
        return this.expiry();
      case 'birthdays':
        return this.birthdays();
      case 'metrics':
        return this.retention.recomputeAll();
      case 'summary':
        return this.dailySummary();
      case 'royalties':
        return this.royalties();
    }
  }

  private async royalties() {
    if (!(await this.features.isEnabled(RequestContext.requireTenantId(), FeatureFlagKey.FRANCHISE))) return { skipped: 'franchise not enabled' };
    return this.franchise.runPreviousMonth();
  }

  /** Claims appointments entering the reminder window (reminderSentAt guard) and emits reminder events. */
  async reminders() {
    const tenantId = RequestContext.requireTenantId();
    const hours = Number((await this.settings.get<number>(tenantId, 'REMINDER_HOURS_BEFORE')) ?? 24);
    const now = new Date();
    const due = await this.db.appointment.findMany({
      where: { status: { in: ['BOOKED', 'CONFIRMED'] }, reminderSentAt: null, startTime: { gt: now, lte: new Date(now.getTime() + hours * 3_600_000) } },
      select: { id: true, customerId: true, branchId: true, startTime: true },
      take: 500,
    });
    let sent = 0;
    for (const a of due) {
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.appointment.updateMany({ where: { id: a.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
        if (!claimed.count) return;
        await this.events.publish(DomainEvents.APPOINTMENT_REMINDER_DUE, { appointmentId: a.id, customerId: a.customerId, branchId: a.branchId, startTime: a.startTime.toISOString() }, tx);
        sent++;
      });
    }
    return { due: due.length, sent };
  }

  async daily(force = false) {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const local = DateTime.now().setZone(tz);
    const today = local.toISODate()!;
    if (!force) {
      if (local.hour < DAILY_HOUR) return { skipped: 'too early' };
      if ((await this.settings.get<string>(tenantId, LAST_DAILY_KEY)) === today) return { skipped: 'already ran today' };
    }
    // Mark first so a crash mid-run is not retried every hour; each step is individually idempotent.
    await this.settings.setMany(tenantId, { [LAST_DAILY_KEY]: today });
    const result: Record<string, unknown> = { date: today };
    for (const [key, fn] of [
      ['expiry', () => this.expiry()],
      ['birthdays', () => this.birthdays()],
      ['metrics', () => this.retention.recomputeAll()],
      ['summary', () => this.dailySummary()],
      ['royalties', () => this.royalties()],
    ] as const) {
      try {
        result[key] = await fn();
      } catch (e) {
        result[key] = { error: (e as Error).message };
        this.logger.error(`Daily step ${key} failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /** Expires lapsed packages/memberships and warns customers whose balances expire soon. */
  async expiry() {
    const tenantId = RequestContext.requireTenantId();
    const settings = await this.settings.getAll(tenantId);
    const tz = String(settings.TIMEZONE ?? 'Asia/Kolkata');
    const now = new Date();
    const [expiredPackages, expiredMemberships] = await Promise.all([this.packages.expireDue(now), this.memberships.expireDue(now)]);

    const pkgDays = Number(settings.PACKAGE_EXPIRY_REMINDER_DAYS ?? 7);
    const packages = await this.db.customerPackage.findMany({
      where: { status: 'ACTIVE', expiryReminderAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + pkgDays * 86_400_000) } },
      include: { package: { select: { name: true } }, items: { select: { totalQuantity: true, usedQuantity: true } } },
    });
    let packageWarnings = 0;
    for (const p of packages) {
      const remaining = p.items.reduce((s, i) => s + i.totalQuantity - i.usedQuantity, 0);
      if (remaining <= 0) continue;
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.customerPackage.updateMany({ where: { id: p.id, expiryReminderAt: null }, data: { expiryReminderAt: new Date() } });
        if (!claimed.count) return;
        await this.events.publish(
          DomainEvents.PACKAGE_EXPIRING,
          { customerPackageId: p.id, customerId: p.customerId, branchId: p.branchId, packageName: p.package.name, expiryDate: formatInZone(p.expiresAt, tz, 'dd LLL yyyy'), remainingSessions: remaining },
          tx,
        );
        packageWarnings++;
      });
    }

    const memDays = Number(settings.MEMBERSHIP_EXPIRY_REMINDER_DAYS ?? 7);
    const memberships = await this.db.customerMembership.findMany({
      where: { status: 'ACTIVE', autoRenew: false, expiryReminderAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + memDays * 86_400_000) } },
      include: { plan: { select: { name: true } } },
    });
    let membershipWarnings = 0;
    for (const m of memberships) {
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.customerMembership.updateMany({ where: { id: m.id, expiryReminderAt: null }, data: { expiryReminderAt: new Date() } });
        if (!claimed.count) return;
        await this.events.publish(
          DomainEvents.MEMBERSHIP_EXPIRING,
          { customerMembershipId: m.id, customerId: m.customerId, branchId: m.branchId, planName: m.plan.name, expiryDate: formatInZone(m.expiresAt, tz, 'dd LLL yyyy') },
          tx,
        );
        membershipWarnings++;
      });
    }
    return { expiredPackages, expiredMemberships, packageWarnings, membershipWarnings };
  }

  async birthdays() {
    const tenantId = RequestContext.requireTenantId();
    const local = DateTime.now().setZone(await this.settings.timezone(tenantId));
    const rows = await this.db.$queryRaw<{ id: string; primaryBranchId: string | null }[]>`
      SELECT id, "primaryBranchId" FROM customers
      WHERE "tenantId" = ${tenantId} AND status = 'ACTIVE' AND dob IS NOT NULL
        AND EXTRACT(MONTH FROM dob) = ${local.month} AND EXTRACT(DAY FROM dob) = ${local.day}`;
    for (const c of rows) await this.events.publish(DomainEvents.CUSTOMER_BIRTHDAY, { customerId: c.id, branchId: c.primaryBranchId, year: local.year });
    return { birthdays: rows.length };
  }

  /** Yesterday at a glance for owners and finance, delivered in-app each morning. */
  async dailySummary() {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const currency = (await this.settings.get<string>(tenantId, 'CURRENCY')) ?? 'INR';
    const y = DateTime.now().setZone(tz).minus({ days: 1 });
    const start = y.startOf('day').toJSDate();
    const end = y.endOf('day').toJSDate();
    const [billed, collected, sessions, newCustomers, feedback] = await Promise.all([
      this.db.invoice.aggregate({ where: { status: { in: ['PAID', 'PARTIALLY_PAID', 'ISSUED'] }, issuedAt: { gte: start, lte: end } }, _sum: { total: true }, _count: { _all: true } }),
      this.db.payment.aggregate({ where: { status: { in: ['SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: start, lte: end } }, _sum: { amount: true } }),
      this.db.therapySession.count({ where: { status: 'COMPLETED', completedAt: { gte: start, lte: end } } }),
      this.db.customer.count({ where: { createdAt: { gte: start, lte: end } } }),
      this.db.feedback.aggregate({ where: { createdAt: { gte: start, lte: end } }, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    const body = [
      `Billed ${formatMoney(num(billed._sum.total), currency)} across ${billed._count._all} invoices`,
      `collected ${formatMoney(num(collected._sum.amount), currency)}`,
      `${sessions} sessions, ${newCustomers} new customers`,
      feedback._count._all ? `avg rating ${feedback._avg.rating?.toFixed(1)}★ (${feedback._count._all})` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const date = y.toISODate()!;
    await this.notifications.notifyStaff({
      permission: PERMISSIONS.REPORTS_FINANCIAL,
      type: 'DAILY_SUMMARY',
      title: `Yesterday (${y.toFormat('dd LLL')}) at a glance`,
      body,
      link: `/reports?report=sales&from=${date}&to=${date}`,
      dedupeKey: `DAILY_SUMMARY:${date}`,
    });
    return { date, sessions, billed: num(billed._sum.total), collected: num(collected._sum.amount) };
  }
}
