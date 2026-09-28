import { Body, Controller, Delete, Get, Global, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationChannel, Prisma } from '@prisma/client';
import { NOTIFICATION_EVENTS, PERMISSIONS } from '@therapyos/types';
import {
  notificationLogQuery,
  notificationPreferenceSchema,
  notificationTemplateSchema,
  templatePreviewSchema,
  testNotificationSchema,
} from '@therapyos/validation';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Zod } from '../../common/pipes/zod.pipe';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { NotificationHandlers } from './notification-handlers';
import { NotificationsService } from './notifications.service';
import { htmlToText, renderTemplate, SAMPLE_VARS, TEMPLATE_VARIABLES, templateError } from './template-renderer';

const CUSTOMER_CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ---- In-app (every signed-in staff user sees their own) ----

  @Get('in-app')
  async inApp(@Query('unreadOnly') unreadOnly?: string, @Query('limit') limit?: string) {
    const userId = RequestContext.userId;
    if (!userId) return { items: [], unread: 0 };
    const where: Prisma.InAppNotificationWhereInput = { userId, ...(unreadOnly === 'true' ? { readAt: null } : {}) };
    const [items, unread] = await Promise.all([
      this.db.inAppNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 30, 100) }),
      this.db.inAppNotification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post('in-app/read-all')
  async readAll() {
    const userId = RequestContext.userId;
    if (!userId) return { updated: 0 };
    const r = await this.db.inAppNotification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: r.count };
  }

  @Post('in-app/:id/read')
  async read(@Param('id') id: string) {
    const r = await this.db.inAppNotification.updateMany({ where: { id, userId: RequestContext.userId ?? '-' }, data: { readAt: new Date() } });
    if (!r.count) throw AppError.notFound('Notification');
    return { read: true };
  }

  // ---- Delivery log ----

  @Get('logs')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async logs(@Query(Zod(notificationLogQuery)) q: z.infer<typeof notificationLogQuery>) {
    const where: Prisma.NotificationLogWhereInput = {};
    if (q.channel) where.channel = q.channel as NotificationChannel;
    if (q.status) where.status = q.status;
    if (q.event) where.event = q.event;
    if (q.customerId) where.customerId = q.customerId;
    if (q.campaignId) where.campaignId = q.campaignId;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) };
    if (q.search) where.OR = [{ recipient: { contains: q.search } }, { body: { contains: q.search, mode: 'insensitive' } }];
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [items, total, byStatus, byChannel] = await Promise.all([
      this.db.notificationLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.notificationLog.count({ where }),
      this.db.notificationLog.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      this.db.notificationLog.groupBy({ by: ['channel'], where: { createdAt: { gte: since }, status: { in: ['SENT', 'DELIVERED'] } }, _count: { _all: true } }),
    ]);
    const customers = await this.db.customer.findMany({ where: { id: { in: items.map((i) => i.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const result = paged(
      items.map((i) => ({ ...i, customerName: i.customerId ? (names.get(i.customerId) ?? null) : null })),
      total,
      q,
    );
    Object.assign(result.meta, {
      summary: {
        last30Days: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        sentByChannel: Object.fromEntries(byChannel.map((s) => [s.channel, s._count._all])),
      },
    });
    return result;
  }

  // ---- Templates ----

  @Get('templates')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async templates() {
    const tenantId = RequestContext.requireTenantId();
    const rows = await this.db.notificationTemplate.findMany({ where: { language: 'en', OR: [{ tenantId }, { tenantId: null }] }, orderBy: [{ event: 'asc' }, { channel: 'asc' }] });
    const events = NOTIFICATION_EVENTS.filter((e) => e !== 'MARKETING').map((event) => ({
      event,
      channels: CUSTOMER_CHANNELS.map((channel) => {
        const system = rows.find((r) => r.tenantId === null && r.event === event && r.channel === channel) ?? null;
        const custom = rows.find((r) => r.tenantId === tenantId && r.event === event && r.channel === channel) ?? null;
        const effective = custom ?? system;
        return { channel, system, custom, effective, active: !!effective?.isActive };
      }),
    }));
    return { events, variables: TEMPLATE_VARIABLES };
  }

  @Put('templates')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async upsertTemplate(@Body(Zod(notificationTemplateSchema)) body: z.infer<typeof notificationTemplateSchema>) {
    const tenantId = RequestContext.requireTenantId();
    if (body.channel === 'PUSH' || body.channel === 'IN_APP') throw AppError.validation('Only WhatsApp, SMS and email templates can be customised.');
    for (const [field, src] of [['body', body.body], ['subject', body.subject ?? '']] as const) {
      const err = templateError(src);
      if (err) throw AppError.validation(`Template ${field} is invalid: ${err}`, { fields: { [field]: err } });
    }
    if (body.channel === 'EMAIL' && !body.subject) throw AppError.validation('Email templates need a subject.', { fields: { subject: 'Required for email' } });
    const existing = await this.db.notificationTemplate.findFirst({ where: { tenantId, event: body.event, channel: body.channel as NotificationChannel, language: body.language } });
    const data = { name: body.name, subject: body.subject ?? null, body: body.body, whatsappTemplateName: body.whatsappTemplateName ?? null, isActive: body.isActive };
    const row = existing
      ? await this.db.notificationTemplate.update({ where: { id: existing.id }, data })
      : await this.db.notificationTemplate.create({ data: { ...data, tenantId, event: body.event, channel: body.channel as NotificationChannel, language: body.language } });
    await this.audit.log({ action: 'NOTIFICATION_TEMPLATE_SAVED', entityType: 'NotificationTemplate', entityId: row.id, newValues: body });
    return row;
  }

  /** Removes the tenant override so the system template applies again. */
  @Delete('templates/:id')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async resetTemplate(@Param('id') id: string) {
    const tenantId = RequestContext.requireTenantId();
    const row = await this.db.notificationTemplate.findFirst({ where: { id, tenantId } });
    if (!row) throw AppError.notFound('Custom template');
    await this.db.notificationTemplate.delete({ where: { id } });
    await this.audit.log({ action: 'NOTIFICATION_TEMPLATE_RESET', entityType: 'NotificationTemplate', entityId: id, oldValues: { event: row.event, channel: row.channel } });
    return { deleted: true };
  }

  @Post('templates/preview')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async preview(@Body(Zod(templatePreviewSchema)) body: z.infer<typeof templatePreviewSchema>) {
    const err = templateError(body.body) ?? (body.subject ? templateError(body.subject) : null);
    if (err) return { valid: false, error: err };
    const tenantId = RequestContext.requireTenantId();
    const vars = { ...SAMPLE_VARS, ...(await this.notifications.baseVars(tenantId)), ...(body.variables ?? {}) };
    const html = renderTemplate(body.body, vars, { html: true });
    const used = [...new Set([...body.body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]))];
    return {
      valid: true,
      subject: body.subject ? renderTemplate(body.subject, vars) : null,
      html,
      text: htmlToText(renderTemplate(body.body, vars)),
      unknownVariables: used.filter((v) => !TEMPLATE_VARIABLES.includes(v)),
    };
  }

  // ---- Preferences ----

  @Get('preferences')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async preferences() {
    const rows = await this.db.notificationPreference.findMany();
    return NOTIFICATION_EVENTS.filter((e) => e !== 'MARKETING').map((event) => ({
      event,
      channels: Object.fromEntries(CUSTOMER_CHANNELS.map((c) => [c, rows.find((r) => r.event === event && r.channel === c)?.enabled ?? true])),
    }));
  }

  @Put('preferences')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  async savePreferences(@Body(Zod(notificationPreferenceSchema)) body: z.infer<typeof notificationPreferenceSchema>) {
    const tenantId = RequestContext.requireTenantId();
    for (const p of body.preferences) {
      await this.db.notificationPreference.upsert({
        where: { tenantId_event_channel: { tenantId, event: p.event, channel: p.channel as NotificationChannel } },
        create: { tenantId, event: p.event, channel: p.channel as NotificationChannel, enabled: p.enabled },
        update: { enabled: p.enabled },
      });
    }
    await this.audit.log({ action: 'NOTIFICATION_PREFERENCES_SAVED', entityType: 'NotificationPreference', newValues: body });
    return this.preferences();
  }

  // ---- Testing aids ----

  @Post('test')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_MANAGE)
  test(@Body(Zod(testNotificationSchema)) body: z.infer<typeof testNotificationSchema>) {
    return this.notifications.sendTest(body.event, body.channel, body.to, SAMPLE_VARS);
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationHandlers],
  exports: [NotificationsService],
})
export class NotificationsModule {}
