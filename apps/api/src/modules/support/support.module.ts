import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, TicketStatus } from '@prisma/client';
import { PERMISSIONS } from '@therapyos/types';
import { supportMessageSchema, supportTicketQuery, supportTicketSchema, supportTicketUpdateSchema } from '@therapyos/validation';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { AllowOnboarding, CurrentUser, JwtPrincipal, PlatformOnly, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type TicketQuery = z.infer<typeof supportTicketQuery>;

@Injectable()
export class SupportService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private where(q: TicketQuery): Prisma.SupportTicketWhereInput {
    const where: Prisma.SupportTicketWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as TicketStatus[] };
    if (q.priority) where.priority = q.priority;
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.search) where.OR = [{ subject: { contains: q.search, mode: 'insensitive' } }, { description: { contains: q.search, mode: 'insensitive' } }];
    return where;
  }

  private async page(q: TicketQuery, withTenant: boolean) {
    const where = this.where(q);
    const [items, total, open] = await Promise.all([
      this.db.supportTicket.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { _count: { select: { messages: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { authorType: true, createdAt: true } } },
      }),
      this.db.supportTicket.count({ where }),
      this.db.supportTicket.groupBy({ by: ['status'], where: q.tenantId ? { tenantId: q.tenantId } : {}, _count: { _all: true } }),
    ]);
    const tenants = withTenant ? await this.db.tenant.findMany({ where: { id: { in: [...new Set(items.map((i) => i.tenantId))] } }, select: { id: true, name: true, slug: true } }) : [];
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const result = paged(
      items.map(({ _count, messages, ...t }) => ({ ...t, messageCount: _count.messages, lastReplyBy: messages[0]?.authorType ?? null, lastReplyAt: messages[0]?.createdAt ?? null, tenant: tenantById.get(t.tenantId) ?? null })),
      total,
      q,
    );
    Object.assign(result.meta, { summary: Object.fromEntries(open.map((o) => [o.status, o._count._all])) });
    return result;
  }

  private async load(id: string) {
    const t = await this.db.supportTicket.findFirst({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!t) throw AppError.notFound('Ticket');
    return t;
  }

  // ---------- tenant side ----------

  list(q: TicketQuery) {
    return this.page({ ...q, tenantId: undefined }, false);
  }

  get(id: string) {
    return this.load(id);
  }

  async create(input: z.infer<typeof supportTicketSchema>) {
    const t = await this.db.supportTicket.create({ data: { ...input, tenantId: RequestContext.requireTenantId(), createdByUserId: RequestContext.userId } });
    await this.audit.log({ action: 'SUPPORT_TICKET_CREATED', entityType: 'SupportTicket', entityId: t.id, newValues: { subject: input.subject, priority: input.priority } });
    return this.load(t.id);
  }

  async reply(id: string, body: string) {
    const t = await this.load(id);
    if (t.status === 'CLOSED') throw AppError.invalidState('This ticket is closed. Open a new ticket instead.');
    await this.db.$transaction([
      this.db.supportTicketMessage.create({ data: { tenantId: t.tenantId, ticketId: id, authorType: 'USER', authorId: RequestContext.userId, authorName: RequestContext.get('userName') ?? null, body } }),
      this.db.supportTicket.update({ where: { id }, data: { status: ['WAITING_ON_CUSTOMER', 'RESOLVED'].includes(t.status) ? 'OPEN' : t.status } }),
    ]);
    return this.load(id);
  }

  async close(id: string) {
    await this.load(id);
    await this.db.supportTicket.update({ where: { id }, data: { status: 'CLOSED' } });
    return this.load(id);
  }

  // ---------- platform side (no tenant context: queries span tenants) ----------

  adminList(q: TicketQuery) {
    return this.page(q, true);
  }

  async adminGet(id: string) {
    const t = await this.load(id);
    const [tenant, creator] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: t.tenantId }, select: { id: true, name: true, slug: true, email: true, phone: true, status: true, subscriptionPlan: { select: { name: true } } } }),
      t.createdByUserId ? this.db.user.findUnique({ where: { id: t.createdByUserId }, select: { id: true, name: true, email: true } }) : null,
    ]);
    return { ...t, tenant, creator };
  }

  async adminReply(id: string, body: string, admin: { id: string; name: string }) {
    const t = await this.load(id);
    await this.db.$transaction([
      this.db.supportTicketMessage.create({ data: { tenantId: t.tenantId, ticketId: id, authorType: 'ADMIN', authorId: admin.id, authorName: admin.name, body } }),
      this.db.supportTicket.update({
        where: { id },
        data: { status: ['OPEN', 'IN_PROGRESS'].includes(t.status) ? 'WAITING_ON_CUSTOMER' : t.status, assignedToAdminId: t.assignedToAdminId ?? admin.id },
      }),
    ]);
    if (t.createdByUserId) {
      await this.notifications.notifyUser(t.tenantId, t.createdByUserId, { type: 'SUPPORT_REPLY', title: `Support replied: ${t.subject}`, body: body.slice(0, 180), link: `/support?ticket=${id}` });
    }
    return this.adminGet(id);
  }

  async adminUpdate(id: string, input: z.infer<typeof supportTicketUpdateSchema>) {
    const before = await this.load(id);
    await this.db.supportTicket.update({ where: { id }, data: input });
    await this.audit.log({ action: 'SUPPORT_TICKET_UPDATED', entityType: 'SupportTicket', entityId: id, oldValues: { status: before.status, priority: before.priority }, newValues: input });
    if (input.status === 'RESOLVED' && before.status !== 'RESOLVED' && before.createdByUserId) {
      await this.notifications.notifyUser(before.tenantId, before.createdByUserId, { type: 'SUPPORT_REPLY', title: `Ticket resolved: ${before.subject}`, body: 'Reply on the ticket if you still need help.', link: `/support?ticket=${id}` });
    }
    return this.adminGet(id);
  }
}

@ApiTags('Support')
@ApiBearerAuth()
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUPPORT_USE)
  list(@Query(Zod(supportTicketQuery)) q: TicketQuery) {
    return this.support.list(q);
  }

  @Post()
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUPPORT_USE)
  create(@Body(Zod(supportTicketSchema)) body: z.infer<typeof supportTicketSchema>) {
    return this.support.create(body);
  }

  @Get(':id')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUPPORT_USE)
  get(@Param('id') id: string) {
    return this.support.get(id);
  }

  @Post(':id/messages')
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUPPORT_USE)
  reply(@Param('id') id: string, @Body(Zod(supportMessageSchema)) body: z.infer<typeof supportMessageSchema>) {
    return this.support.reply(id, body.body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @AllowOnboarding()
  @RequirePermissions(PERMISSIONS.SUPPORT_USE)
  close(@Param('id') id: string) {
    return this.support.close(id);
  }
}

@ApiTags('Admin')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query(Zod(supportTicketQuery)) q: TicketQuery) {
    return this.support.adminList(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.support.adminGet(id);
  }

  @Post(':id/messages')
  reply(@Param('id') id: string, @Body(Zod(supportMessageSchema)) body: z.infer<typeof supportMessageSchema>, @CurrentUser() admin: JwtPrincipal) {
    return this.support.adminReply(id, body.body, { id: admin.sub, name: admin.name ?? 'TherapyOS Support' });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(Zod(supportTicketUpdateSchema)) body: z.infer<typeof supportTicketUpdateSchema>) {
    return this.support.adminUpdate(id, body);
  }
}

@Module({ controllers: [SupportController, AdminSupportController], providers: [SupportService], exports: [SupportService] })
export class SupportModule {}
