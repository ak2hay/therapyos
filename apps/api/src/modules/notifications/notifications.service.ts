import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import { FeatureFlagKey } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { env } from '../../config/env';
import { AuthzService } from '../../core/authz.service';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { SendResult } from '../../integrations/messaging.providers';
import { ProviderFactory } from '../../integrations/provider.factory';
import { bullConnection, QUEUES, QueueService, shouldRunWorkers } from '../../jobs/queue.service';
import { jobCounter } from '../../observability/observability';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { htmlToText, renderTemplate, TemplateVars } from './template-renderer';

type Channel = 'SMS' | 'EMAIL' | 'WHATSAPP';

/** Promotional events need explicit marketing consent (DPDP / TRAI DND). Transactional ones do not. */
const PROMOTIONAL_EVENTS = new Set(['MARKETING', 'WIN_BACK', 'BIRTHDAY']);
const MAX_ATTEMPTS = 3;

export interface NotifyOptions {
  refType?: string;
  refId?: string;
  branchId?: string | null;
  campaignId?: string;
  /** Restricts delivery to these channels (campaigns pick exactly one). */
  channels?: Channel[];
  bodyOverride?: string;
  subjectOverride?: string;
  /** Stable key that makes the send idempotent; defaults to event + reference. */
  dedupeKey?: string;
}

export interface StaffAlert {
  permission: string;
  branchId?: string | null;
  type: string;
  title: string;
  body: string;
  link?: string;
  dedupeKey?: string;
  email?: { event: string; vars: TemplateVars };
}

interface DeliveryJob {
  logId: string;
  tenantId: string | null;
  whatsappTemplateName?: string | null;
  smsTemplateId?: string | null;
  templateParams?: string[];
}

interface TemplateRow {
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
  smsTemplateId: string | null;
  isActive: boolean;
}

@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private worker?: Worker<DeliveryJob>;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly features: FeaturesService,
    private readonly authz: AuthzService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeService,
    private readonly providers: ProviderFactory,
  ) {}

  onApplicationBootstrap() {
    if (!shouldRunWorkers()) return;
    this.worker = new Worker<DeliveryJob>(QUEUES.NOTIFICATIONS, (job) => this.processJob(job), { connection: bullConnection(), concurrency: 5 });
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      this.logger.warn(`Notification ${job.data.logId} failed (attempt ${job.attemptsMade}): ${err.message}`);
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.db.notificationLog.update({ where: { id: job.data.logId }, data: { status: 'FAILED', error: err.message.slice(0, 500) } }).catch(() => undefined);
      }
    });
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
  }

  /** Seeds and bulk back-fills replay historical events; they must never message real customers. */
  private get suppressed() {
    return process.env.NOTIFICATIONS_SUPPRESS === 'true';
  }

  /** Variables available to every template: business and branch names, booking link. */
  async baseVars(tenantId: string, branchId?: string | null): Promise<TemplateVars> {
    const [tenant, branding, branch] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } }),
      this.db.tenantBranding.findUnique({ where: { tenantId }, select: { appName: true } }),
      branchId ? this.db.branch.findFirst({ where: { id: branchId }, select: { name: true } }) : null,
    ]);
    return {
      business_name: branding?.appName || tenant?.name || '',
      branch_name: branch?.name ?? '',
      booking_link: tenant ? `${env().APP_URL}/book/${tenant.slug}` : '',
    };
  }

  /** Tenant overrides win over system templates per channel; an inactive override disables that channel. */
  async resolveTemplates(tenantId: string, event: string): Promise<Map<Channel, TemplateRow>> {
    const rows = await this.db.notificationTemplate.findMany({
      where: { event, language: 'en', OR: [{ tenantId }, { tenantId: null }] },
      orderBy: { tenantId: { sort: 'asc', nulls: 'first' } },
    });
    const map = new Map<Channel, TemplateRow>();
    for (const r of rows) if (r.channel !== 'PUSH' && r.channel !== 'IN_APP') map.set(r.channel as Channel, r);
    for (const [k, v] of map) if (!v.isActive) map.delete(k);
    return map;
  }

  private async whatsappAvailable(tenantId: string) {
    const [flag, setting] = await Promise.all([this.features.isEnabled(tenantId, FeatureFlagKey.WHATSAPP_ENABLED), this.settings.get<boolean>(tenantId, 'WHATSAPP_ENABLED')]);
    return flag && setting === true;
  }

  /**
   * Sends a customer-facing notification through every configured channel, honouring tenant
   * preferences and customer consent. Each channel send is recorded in `notification_logs` and
   * delivered by the notifications worker; a unique dedupe key makes retried events harmless.
   */
  async notifyCustomer(event: string, customerId: string, vars: TemplateVars, opts: NotifyOptions = {}) {
    if (this.suppressed) return { queued: 0, skipped: ['suppressed'] };
    const tenantId = RequestContext.requireTenantId();
    const customer = await this.db.customer.findFirst({
      where: { id: customerId },
      select: { id: true, name: true, phone: true, email: true, marketingOptIn: true, whatsappOptIn: true, status: true },
    });
    if (!customer) return { queued: 0, skipped: ['customer not found'] };

    const [templates, prefs, waOk, base] = await Promise.all([
      this.resolveTemplates(tenantId, event),
      this.db.notificationPreference.findMany({ where: { event } }),
      this.whatsappAvailable(tenantId),
      this.baseVars(tenantId, opts.branchId),
    ]);
    const enabled = (c: Channel) => prefs.find((p) => p.channel === c)?.enabled ?? true;
    const allVars: TemplateVars = { ...base, customer_name: customer.name.split(' ')[0], ...vars };

    // Build the plan: which channel gets which template body.
    const plan: Array<{ channel: Channel; tpl: TemplateRow | null }> = [];
    if (opts.channels?.length) {
      for (const c of opts.channels) plan.push({ channel: c, tpl: templates.get(c) ?? null });
    } else {
      for (const [c, tpl] of templates) plan.push({ channel: c, tpl });
    }

    const skipped: string[] = [];
    let queued = 0;
    const baseKey = opts.dedupeKey ?? (opts.refId ? `${event}:${opts.refType ?? 'ref'}:${opts.refId}` : null);
    const record = async (channel: Channel, status: 'QUEUED' | 'SKIPPED', data: { recipient: string; subject?: string | null; body: string; error?: string }, job?: Omit<DeliveryJob, 'logId' | 'tenantId'>) => {
      try {
        const log = await this.db.notificationLog.create({
          data: {
            tenantId,
            customerId,
            event,
            channel,
            recipient: data.recipient,
            subject: data.subject ?? null,
            body: data.body,
            status,
            error: data.error,
            refType: opts.refType,
            refId: opts.refId,
            campaignId: opts.campaignId,
            dedupeKey: baseKey ? `${tenantId}:${baseKey}:${channel}` : null,
          },
        });
        if (status === 'QUEUED') {
          queued++;
          await this.enqueue({ logId: log.id, tenantId, ...job });
        }
        return log;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          skipped.push(`${channel}: already sent`);
          return null;
        }
        throw e;
      }
    };

    if (customer.status !== 'ACTIVE') return { queued: 0, skipped: ['customer inactive'] };
    const promotional = PROMOTIONAL_EVENTS.has(event);
    const smsPlanned = plan.some((p) => p.channel === 'SMS');

    for (const { channel, tpl } of plan) {
      const bodySource = opts.bodyOverride ?? tpl?.body;
      if (!bodySource) continue;
      if (!enabled(channel)) {
        skipped.push(`${channel}: disabled in preferences`);
        continue;
      }
      if (promotional && !customer.marketingOptIn) {
        await record(channel, 'SKIPPED', { recipient: channel === 'EMAIL' ? (customer.email ?? '-') : customer.phone, body: '', error: 'No marketing consent' });
        skipped.push(`${channel}: no marketing consent`);
        continue;
      }
      let target: Channel = channel;
      if (channel === 'WHATSAPP' && (!waOk || !customer.whatsappOptIn)) {
        // WhatsApp unavailable: fall back to SMS with the same copy unless SMS is already planned.
        if (smsPlanned || !enabled('SMS')) {
          skipped.push('WHATSAPP: unavailable');
          continue;
        }
        target = 'SMS';
      }
      if (target === 'EMAIL') {
        if (!customer.email) {
          skipped.push('EMAIL: no address');
          continue;
        }
        const subject = renderTemplate(opts.subjectOverride ?? tpl?.subject ?? '{{business_name}}', allVars);
        const html = renderTemplate(bodySource, allVars, { html: true });
        await record('EMAIL', 'QUEUED', { recipient: customer.email, subject, body: html });
        continue;
      }
      const text = htmlToText(renderTemplate(bodySource, allVars));
      let job: Omit<DeliveryJob, 'logId' | 'tenantId'> | undefined;
      if (target === 'WHATSAPP' && !opts.bodyOverride && tpl?.whatsappTemplateName) {
        job = { whatsappTemplateName: tpl.whatsappTemplateName, templateParams: templateParams(bodySource, allVars) };
      } else if (target === 'SMS' && !opts.bodyOverride) {
        // DLT templates are registered against the SMS copy, so the variables come from that template.
        const smsTpl = tpl?.channel === 'SMS' ? tpl : templates.get('SMS');
        if (smsTpl?.smsTemplateId) job = { smsTemplateId: smsTpl.smsTemplateId, templateParams: templateParams(smsTpl.body, allVars) };
      }
      await record(target, 'QUEUED', { recipient: customer.phone, body: text }, job);
    }
    return { queued, skipped };
  }

  private async enqueue(job: DeliveryJob) {
    // Seeds and integration tests run without workers: deliver synchronously so results are visible.
    if (process.env.DISABLE_WORKERS === 'true') {
      await this.deliver(job);
      return;
    }
    await this.queues.add(QUEUES.NOTIFICATIONS, 'send', job, { jobId: job.logId, attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } });
  }

  private async processJob(job: Job<DeliveryJob>) {
    try {
      await RequestContext.runAsTenant(job.data.tenantId ?? undefined, () => this.deliver(job.data, true), { requestId: `ntf_${job.data.logId}` });
      jobCounter.inc({ queue: QUEUES.NOTIFICATIONS, name: 'send', result: 'success' });
    } catch (e) {
      jobCounter.inc({ queue: QUEUES.NOTIFICATIONS, name: 'send', result: 'failure' });
      throw e;
    }
  }

  /** Sends one logged message. With `retryable`, provider failures throw so BullMQ retries with backoff. */
  async deliver(job: DeliveryJob, retryable = false) {
    const log = await this.db.notificationLog.findUnique({ where: { id: job.logId } });
    if (!log || log.status !== 'QUEUED') return;
    let result: SendResult;
    try {
      result = await this.send(log.channel as Channel, log.recipient, log.body, log.subject, log.tenantId, job);
    } catch (e) {
      result = { provider: 'unknown', status: 'FAILED', error: (e as Error).message };
    }
    const attempts = log.attempts + 1;
    if (result.status === 'SENT') {
      await this.db.notificationLog.update({ where: { id: log.id }, data: { status: 'SENT', provider: result.provider, providerMessageId: result.messageId, sentAt: new Date(), attempts, error: null } });
      return;
    }
    const final = !retryable || attempts >= MAX_ATTEMPTS;
    await this.db.notificationLog.update({ where: { id: log.id }, data: { status: final ? 'FAILED' : 'QUEUED', provider: result.provider, error: result.error?.slice(0, 500), attempts } });
    if (!final) throw new Error(result.error ?? 'Delivery failed');
  }

  private async send(channel: Channel, to: string, body: string, subject: string | null, tenantId: string | null, job: Partial<DeliveryJob>): Promise<SendResult> {
    switch (channel) {
      case 'SMS':
        return (await this.providers.sms(tenantId)).send(to, body, { templateId: job.smsTemplateId, params: job.templateParams });
      case 'WHATSAPP':
        return (await this.providers.whatsapp(tenantId)).send({ to, body, templateName: job.whatsappTemplateName ?? undefined, templateParams: job.templateParams });
      case 'EMAIL': {
        const branding = tenantId ? await this.db.tenantBranding.findUnique({ where: { tenantId }, select: { emailSenderName: true, emailSenderAddress: true, appName: true } }) : null;
        return (await this.providers.email(tenantId)).send(to, subject ?? 'Notification', emailLayout(body, branding?.appName ?? null), {
          fromName: branding?.emailSenderName ?? branding?.appName ?? undefined,
          fromAddress: branding?.emailSenderAddress ?? undefined,
        });
      }
    }
  }

  /** Sends a rendered sample of a template to an arbitrary address (settings "send test"). */
  async sendTest(event: string, channel: Channel, to: string, vars: TemplateVars) {
    const tenantId = RequestContext.requireTenantId();
    const templates = await this.resolveTemplates(tenantId, event);
    const tpl = templates.get(channel) ?? (channel === 'SMS' ? templates.get('WHATSAPP') : undefined);
    if (!tpl) return { sent: false, error: `No ${channel.toLowerCase()} template for ${event}` };
    const allVars = { ...vars, ...(await this.baseVars(tenantId)) };
    const subject = channel === 'EMAIL' ? renderTemplate(tpl.subject ?? '{{business_name}}', allVars) : null;
    const body = channel === 'EMAIL' ? renderTemplate(tpl.body, allVars, { html: true }) : htmlToText(renderTemplate(tpl.body, allVars));
    const log = await this.db.notificationLog.create({
      data: { tenantId, userId: RequestContext.userId ?? null, event, channel, recipient: to, subject, body: body, status: 'QUEUED', refType: 'TEST' },
    });
    const smsTemplate = channel === 'SMS' && tpl.channel === 'SMS' && tpl.smsTemplateId ? { smsTemplateId: tpl.smsTemplateId, templateParams: templateParams(tpl.body, allVars) } : {};
    await this.deliver({ logId: log.id, tenantId, ...smsTemplate });
    return this.db.notificationLog.findUnique({ where: { id: log.id } });
  }

  /**
   * Fans an alert out to every active user holding `permission` with access to the branch, as
   * in-app notifications (pushed live over the socket) and optionally an email.
   */
  /** In-app notification for one staff member; tenant is explicit so platform admins can notify too. */
  async notifyUser(tenantId: string, userId: string, n: { type: string; title: string; body: string; link?: string }) {
    if (this.suppressed) return null;
    const row = await this.db.inAppNotification.create({ data: { tenantId, userId, type: n.type, title: n.title, body: n.body, link: n.link } });
    this.realtime.toUser(userId, 'notification', { id: row.id, title: row.title, body: row.body, link: row.link, type: row.type, createdAt: row.createdAt });
    return row;
  }

  async notifyStaff(alert: StaffAlert) {
    if (this.suppressed) return { recipients: 0 };
    const tenantId = RequestContext.requireTenantId();
    const users = await this.db.user.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, email: true } });
    const recipients: Array<{ id: string; email: string | null }> = [];
    for (const u of users) {
      const a = await this.authz.getUserAuthz(u.id);
      if (!a || !a.permissions.includes(alert.permission)) continue;
      if (alert.branchId && !a.allBranches && !a.branchIds.includes(alert.branchId)) continue;
      recipients.push(u);
    }
    if (alert.dedupeKey) {
      // In-app rows have no unique key; a same-day duplicate check keeps retries quiet.
      const since = new Date(Date.now() - 20 * 3_600_000);
      const dup = await this.db.inAppNotification.findFirst({ where: { type: alert.type, link: alert.link ?? null, title: alert.title, createdAt: { gte: since } } });
      if (dup) return { recipients: 0 };
    }
    for (const u of recipients) {
      const row = await this.db.inAppNotification.create({
        data: { tenantId, userId: u.id, branchId: alert.branchId ?? null, type: alert.type, title: alert.title, body: alert.body, link: alert.link },
      });
      this.realtime.toUser(u.id, 'notification', { id: row.id, title: row.title, body: row.body, link: row.link, type: row.type, createdAt: row.createdAt });
    }
    if (alert.email) {
      const templates = await this.resolveTemplates(tenantId, alert.email.event);
      const tpl = templates.get('EMAIL');
      if (tpl) {
        const vars = { ...(await this.baseVars(tenantId, alert.branchId)), ...alert.email.vars };
        for (const u of recipients.filter((r) => r.email)) {
          try {
            const log = await this.db.notificationLog.create({
              data: {
                tenantId,
                userId: u.id,
                event: alert.email.event,
                channel: 'EMAIL',
                recipient: u.email!,
                subject: renderTemplate(tpl.subject ?? alert.title, vars),
                body: renderTemplate(tpl.body, vars, { html: true }),
                refType: alert.type,
                dedupeKey: alert.dedupeKey ? `${tenantId}:${alert.dedupeKey}:${u.id}` : null,
              },
            });
            await this.enqueue({ logId: log.id, tenantId });
          } catch (e) {
            if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
          }
        }
      }
    }
    return { recipients: recipients.length };
  }
}

/** Values for `{{placeholders}}` in order of first appearance: WhatsApp approved templates are positional. */
export function templateParams(body: string, vars: TemplateVars): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen.map((k) => String(vars[k] ?? ''));
}

function emailLayout(inner: string, brand: string | null) {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e7eb">${inner}</div>
${brand ? `<p style="text-align:center;font-size:12px;color:#9ca3af">${brand}</p>` : ''}</body></html>`;
}
