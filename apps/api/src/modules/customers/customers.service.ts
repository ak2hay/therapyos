import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from '@therapyos/types';
import { customerListQuery, CustomerInput, updateCustomerSchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { dateOnly } from '../../common/utils/dates';
import { pageArgs, paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { FeaturesService } from '../../core/features.service';

type ListQuery = z.infer<typeof customerListQuery>;
type UpdateInput = z.infer<typeof updateCustomerSchema>;

export const maskPhone = (p: string | null | undefined) => (p ? `${p.slice(0, 3)}******${p.slice(-2)}` : p);
export const maskEmail = (e: string | null | undefined) => (e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : e);

/** Hides contact details from roles without `customer.contact.view` (e.g. therapists by default). */
export function maskContact<T extends { phone?: string | null; email?: string | null }>(c: T): T {
  if (RequestContext.hasPermission(PERMISSIONS.CUSTOMER_CONTACT_VIEW) || !RequestContext.userId) return c;
  return { ...c, phone: maskPhone(c.phone) as T['phone'], email: maskEmail(c.email) as T['email'] };
}

@Injectable()
export class CustomersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly features: FeaturesService,
  ) {}

  async list(q: ListQuery) {
    const where: Prisma.CustomerWhereInput = {};
    if (q.search) {
      const s = q.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s.replace(/\s/g, '') } },
        { email: { contains: s, mode: 'insensitive' } },
        { customerCode: { equals: s.toUpperCase() } },
      ];
    }
    if (q.status) where.status = q.status as never;
    if (q.source) where.source = q.source as never;
    if (q.segment) where.metrics = { segment: q.segment as never };
    if (q.branchId) {
      RequestContext.assertBranch(q.branchId);
      where.AND = [{ OR: [{ primaryBranchId: q.branchId }, { sessions: { some: { branchId: q.branchId } } }] }];
    }
    const orderBy: Prisma.CustomerOrderByWithRelationInput =
      q.sort === 'name' ? { name: q.order } : q.sort === 'lastVisit' ? { metrics: { lastVisitAt: q.order } } : q.sort === 'spend' ? { metrics: { totalSpend: q.order } } : { createdAt: q.order };
    const [items, total] = await Promise.all([
      this.db.customer.findMany({ where, include: { metrics: true }, orderBy, ...pageArgs(q) }),
      this.db.customer.count({ where }),
    ]);
    return paged(items.map(maskContact), total, q);
  }

  /** Fast lookup used by the reception search box and walk-in flow. */
  async lookup(term: string) {
    const s = term.trim();
    if (s.length < 2) return [];
    const items = await this.db.customer.findMany({
      where: {
        status: { not: 'BLOCKED' },
        OR: [{ phone: { contains: s.replace(/\s/g, '') } }, { name: { contains: s, mode: 'insensitive' } }, { customerCode: s.toUpperCase() }],
      },
      select: { id: true, name: true, phone: true, email: true, customerCode: true, metrics: { select: { segment: true, lastVisitAt: true, visitCount: true } } },
      take: 10,
      orderBy: { name: 'asc' },
    });
    return items.map(maskContact);
  }

  async get(id: string) {
    const c = await this.db.customer.findFirst({
      where: { id },
      include: {
        metrics: true,
        packages: {
          where: { status: 'ACTIVE' },
          include: { package: { select: { name: true } }, items: { include: { service: { select: { id: true, name: true } } } } },
          orderBy: { expiresAt: 'asc' },
        },
        memberships: { where: { status: 'ACTIVE' }, include: { plan: { select: { name: true } } } },
        appointments: {
          where: { startTime: { gte: new Date() }, status: { in: ['BOOKED', 'CONFIRMED'] } },
          include: { service: { select: { name: true } }, therapist: { select: { name: true } }, branch: { select: { name: true } } },
          orderBy: { startTime: 'asc' },
          take: 5,
        },
      },
    });
    if (!c) throw AppError.notFound('Customer');
    const referredBy = c.referredById ? await this.db.customer.findFirst({ where: { id: c.referredById }, select: { id: true, name: true } }) : null;
    const [openInvoices, lastFeedback] = await Promise.all([
      this.db.invoice.aggregate({ where: { customerId: id, status: { in: ['PARTIALLY_PAID', 'ISSUED'] } }, _sum: { total: true, amountPaid: true } }),
      this.db.feedback.findFirst({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const outstanding = Number(openInvoices._sum.total ?? 0) - Number(openInvoices._sum.amountPaid ?? 0);
    return maskContact({ ...c, referredBy, outstanding, lastFeedback });
  }

  private async nextCode(client: DbOrTx): Promise<string> {
    const last = await client.customer.findFirst({ where: { customerCode: { startsWith: 'C' } }, orderBy: { customerCode: 'desc' }, select: { customerCode: true } });
    const n = last ? Number(last.customerCode.replace(/\D/g, '')) + 1 : 1;
    return `C${String(n).padStart(5, '0')}`;
  }

  async create(input: CustomerInput, client?: DbOrTx) {
    const tenantId = RequestContext.requireTenantId();
    await this.features.assertWithinLimit(tenantId, 'customers');
    if (input.primaryBranchId) RequestContext.assertBranch(input.primaryBranchId);
    const existing = await (client ?? this.db).customer.findFirst({ where: { phone: input.phone }, select: { id: true, name: true } });
    if (existing) {
      throw new AppError(ErrorCode.DUPLICATE, `A customer with this phone already exists (${existing.name}).`, 409, { customerId: existing.id });
    }
    const run = async (tx: DbOrTx) => {
      let customer;
      for (let attempt = 0; ; attempt++) {
        try {
          customer = await tx.customer.create({
            data: {
              ...input,
              tenantId,
              customerCode: await this.nextCode(tx),
              dob: input.dob ? dateOnly(input.dob) : undefined,
              tags: input.tags ?? [],
              source: input.source as never,
              gender: input.gender as never,
              metrics: { create: { tenantId } },
            },
          });
          break;
        } catch (err) {
          const target = (err as Prisma.PrismaClientKnownRequestError).meta?.target;
          if (attempt < 3 && (err as Prisma.PrismaClientKnownRequestError).code === 'P2002' && String(target).includes('customerCode')) continue;
          throw err;
        }
      }
      await tx.customerConsent.createMany({
        data: [
          { tenantId, customerId: customer.id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', granted: input.whatsappOptIn, source: 'REGISTRATION' },
          { tenantId, customerId: customer.id, channel: 'ALL', purpose: 'MARKETING', granted: input.marketingOptIn, source: 'REGISTRATION' },
        ],
      });
      await this.activity.record({ customerId: customer.id, branchId: input.primaryBranchId, type: 'CUSTOMER_CREATED', title: 'Customer registered', meta: { source: input.source } }, tx);
      await this.events.publish(DomainEvents.CUSTOMER_CREATED, { customerId: customer.id, branchId: input.primaryBranchId ?? null, source: input.source }, tx);
      return customer;
    };
    const customer = client ? await run(client) : await this.db.$transaction(run);
    await this.audit.log({ action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id, newValues: { name: input.name, source: input.source } });
    return customer;
  }

  /** Finds a customer by phone or registers them (walk-ins, public booking, WhatsApp). */
  async findOrCreate(input: { name: string; phone: string; email?: string; branchId?: string; source?: string }, client?: DbOrTx) {
    const existing = await (client ?? this.db).customer.findFirst({ where: { phone: input.phone } });
    if (existing) {
      if (existing.status === 'BLOCKED') throw AppError.forbidden('This customer is blocked.');
      return existing;
    }
    return this.create(
      {
        name: input.name,
        phone: input.phone,
        email: input.email,
        primaryBranchId: input.branchId,
        source: input.source ?? 'WALK_IN',
        marketingOptIn: false,
        whatsappOptIn: true,
      },
      client,
    );
  }

  async update(id: string, input: UpdateInput) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.db.customer.findFirst({ where: { id } });
    if (!before) throw AppError.notFound('Customer');
    if (input.phone && input.phone !== before.phone) {
      const clash = await this.db.customer.findFirst({ where: { phone: input.phone, id: { not: id } } });
      if (clash) throw new AppError(ErrorCode.DUPLICATE, 'Another customer already uses this phone number.', 409, { customerId: clash.id });
    }
    const { dob, ...rest } = input;
    const customer = await this.db.customer.update({
      where: { id },
      data: { ...rest, source: rest.source as never, gender: rest.gender as never, dob: dob ? dateOnly(dob) : undefined },
    });
    const consents: Prisma.CustomerConsentCreateManyInput[] = [];
    if (input.marketingOptIn !== undefined && input.marketingOptIn !== before.marketingOptIn) {
      consents.push({ tenantId, customerId: id, channel: 'ALL', purpose: 'MARKETING', granted: input.marketingOptIn, source: 'STAFF_UPDATE' });
    }
    if (input.whatsappOptIn !== undefined && input.whatsappOptIn !== before.whatsappOptIn) {
      consents.push({ tenantId, customerId: id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', granted: input.whatsappOptIn, source: 'STAFF_UPDATE' });
    }
    if (consents.length) await this.db.customerConsent.createMany({ data: consents });
    await this.audit.log({
      action: 'CUSTOMER_UPDATED',
      entityType: 'Customer',
      entityId: id,
      oldValues: { name: before.name, phone: before.phone, status: before.status },
      newValues: input,
    });
    return customer;
  }

  async addNote(id: string, note: string) {
    const c = await this.db.customer.findFirst({ where: { id }, select: { id: true, primaryBranchId: true } });
    if (!c) throw AppError.notFound('Customer');
    await this.activity.record({ customerId: id, branchId: c.primaryBranchId, type: 'NOTE', title: 'Note added', meta: { note, by: RequestContext.get('userName') } });
    return { ok: true };
  }

  async timeline(id: string, page = 1, pageSize = 30, type?: string) {
    const c = await this.db.customer.findFirst({ where: { id }, select: { id: true } });
    if (!c) throw AppError.notFound('Customer');
    const where: Prisma.CustomerActivityWhereInput = { customerId: id, ...(type ? { type } : {}) };
    const [items, total] = await Promise.all([
      this.db.customerActivity.findMany({ where, orderBy: { occurredAt: 'desc' }, ...pageArgs({ page, pageSize }) }),
      this.db.customerActivity.count({ where }),
    ]);
    return paged(items, total, { page, pageSize });
  }

  async history(id: string) {
    const [sessions, invoices, appointments] = await Promise.all([
      this.db.therapySession.findMany({
        where: { customerId: id },
        include: { service: { select: { name: true } }, therapist: { select: { name: true } }, branch: { select: { name: true } }, feedback: { select: { rating: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.db.invoice.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, invoiceNumber: true, total: true, amountPaid: true, status: true, createdAt: true, branchId: true } }),
      this.db.appointment.findMany({
        where: { customerId: id },
        include: { service: { select: { name: true } }, therapist: { select: { name: true } } },
        orderBy: { startTime: 'desc' },
        take: 50,
      }),
    ]);
    return { sessions, invoices, appointments };
  }

  /**
   * Customers with financial history are anonymised (invoices must be retained); customers
   * with no history are removed outright.
   */
  async remove(id: string) {
    const c = await this.db.customer.findFirst({ where: { id }, include: { _count: { select: { invoices: true, sessions: true } } } });
    if (!c) throw AppError.notFound('Customer');
    if (c._count.invoices === 0 && c._count.sessions === 0) {
      await this.db.$transaction(async (tx) => {
        await tx.appointment.deleteMany({ where: { customerId: id } });
        await tx.queueEntry.deleteMany({ where: { customerId: id } });
        await tx.customerConsent.deleteMany({ where: { customerId: id } });
        await tx.customer.delete({ where: { id } });
      });
      await this.audit.log({ action: 'CUSTOMER_DELETED', entityType: 'Customer', entityId: id, oldValues: { name: c.name } });
      return { id, mode: 'deleted' };
    }
    await this.db.customer.update({
      where: { id },
      data: { name: 'Deleted customer', phone: `deleted-${id}`, email: null, dob: null, address: null, notes: null, tags: [], status: 'INACTIVE', marketingOptIn: false, whatsappOptIn: false },
    });
    await this.audit.log({ action: 'CUSTOMER_ANONYMISED', entityType: 'Customer', entityId: id, oldValues: { name: c.name } });
    return { id, mode: 'anonymised' };
  }
}
