import { Injectable, Logger } from '@nestjs/common';
import { CustomerPackageStatus, Prisma } from '@prisma/client';
import { PackageInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { addDays } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { OnDomainEvent } from '../../jobs/event-handlers';
import { LedgerService } from '../ledger/ledger.service';
import { maskContact } from '../customers/customers.service';

export interface RedeemInput {
  customerPackageId: string;
  serviceId: string;
  quantity?: number;
  sessionId?: string | null;
  branchId: string;
  at?: Date;
}

const customerPackageInclude = {
  package: { select: { id: true, name: true, validityDays: true, price: true } },
  items: { include: { service: { select: { id: true, name: true } } } },
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } },
} satisfies Prisma.CustomerPackageInclude;

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly ledger: LedgerService,
  ) {}

  // ---------- catalogue ----------

  async list(q: { active?: boolean }) {
    const rows = await this.db.package.findMany({
      where: q.active ? { status: 'ACTIVE' } : {},
      include: { items: { include: { service: { select: { id: true, name: true, basePrice: true } } } }, _count: { select: { customerPackages: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map(({ _count, ...p }) => {
      const worth = round2(p.items.reduce((s, i) => s + num(i.service.basePrice) * i.quantity, 0));
      return { ...p, soldCount: _count.customerPackages, worth, savings: Math.max(0, round2(worth - num(p.price))) };
    });
  }

  async get(id: string) {
    const p = await this.db.package.findFirst({ where: { id }, include: { items: { include: { service: { select: { id: true, name: true, basePrice: true } } } } } });
    if (!p) throw AppError.notFound('Package');
    return p;
  }

  private async assertServices(serviceIds: string[]) {
    const unique = [...new Set(serviceIds)];
    if (unique.length !== serviceIds.length) throw AppError.validation('Each service can appear only once in a package.');
    const count = await this.db.service.count({ where: { id: { in: unique } } });
    if (count !== unique.length) throw AppError.notFound('Service');
  }

  async create(input: PackageInput) {
    const tenantId = RequestContext.requireTenantId();
    await this.assertServices(input.items.map((i) => i.serviceId));
    const { items, ...data } = input;
    const pkg = await this.db.package.create({ data: { ...data, tenantId, items: { create: items } } });
    await this.audit.log({ action: 'PACKAGE_CREATED', entityType: 'Package', entityId: pkg.id, newValues: input });
    return this.get(pkg.id);
  }

  async update(id: string, input: Partial<PackageInput>) {
    const before = await this.get(id);
    if (input.items) await this.assertServices(input.items.map((i) => i.serviceId));
    const { items, ...data } = input;
    await this.db.$transaction(async (tx) => {
      await tx.package.update({ where: { id }, data });
      if (items) {
        await tx.packageItem.deleteMany({ where: { packageId: id } });
        await tx.packageItem.createMany({ data: items.map((i) => ({ ...i, packageId: id })) });
      }
    });
    // Already-sold packages keep their snapshot of items; only new sales see the change.
    await this.audit.log({ action: num(before.price) !== num(input.price ?? before.price) ? 'PRICE_CHANGED' : 'PACKAGE_UPDATED', entityType: 'Package', entityId: id, oldValues: { price: before.price, status: before.status }, newValues: input });
    return this.get(id);
  }

  // ---------- customer packages ----------

  async listCustomerPackages(q: { page: number; pageSize: number; customerId?: string; status?: string; search?: string; expiringInDays?: number }) {
    const where: Prisma.CustomerPackageWhereInput = {};
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = { in: q.status.split(',') as CustomerPackageStatus[] };
    if (q.search) where.customer = { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] };
    if (q.expiringInDays) {
      where.status = 'ACTIVE';
      where.expiresAt = { gte: new Date(), lte: addDays(new Date(), q.expiringInDays) };
    }
    const [items, total] = await Promise.all([
      this.db.customerPackage.findMany({ where, include: customerPackageInclude, orderBy: { purchasedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.customerPackage.count({ where }),
    ]);
    return paged(items.map((cp) => this.present(cp)), total, q);
  }

  private present<T extends { items: { totalQuantity: number; usedQuantity: number }[]; customer: { phone: string | null; email: string | null } }>(cp: T) {
    const total = cp.items.reduce((s, i) => s + i.totalQuantity, 0);
    const used = cp.items.reduce((s, i) => s + i.usedQuantity, 0);
    return { ...cp, customer: maskContact(cp.customer), totalSessions: total, usedSessions: used, remainingSessions: total - used };
  }

  async getCustomerPackage(id: string) {
    const cp = await this.db.customerPackage.findFirst({
      where: { id },
      include: { ...customerPackageInclude, redemptions: { orderBy: { redeemedAt: 'desc' } } },
    });
    if (!cp) throw AppError.notFound('Customer package');
    const serviceNames = new Map(cp.items.map((i) => [i.serviceId, i.service.name]));
    return { ...this.present(cp), redemptions: cp.redemptions.map((r) => ({ ...r, serviceName: serviceNames.get(r.serviceId) ?? null })) };
  }

  /** Active, unexpired packages that still have sessions left for a service (reception + POS pickers). */
  async eligible(customerId: string, serviceId?: string) {
    const rows = await this.db.customerPackage.findMany({
      where: { customerId, status: 'ACTIVE', expiresAt: { gt: new Date() }, ...(serviceId ? { items: { some: { serviceId } } } : {}) },
      include: customerPackageInclude,
      orderBy: { expiresAt: 'asc' },
    });
    return rows
      .map((cp) => this.present(cp))
      .filter((cp) => !serviceId || cp.items.some((i) => i.serviceId === serviceId && i.totalQuantity > i.usedQuantity));
  }

  /** Called at checkout: the package is sold but not usable until its invoice is fully paid. */
  async createPending(tx: DbOrTx, input: { customerId: string; packageId: string; branchId: string; invoiceId: string }) {
    const tenantId = RequestContext.requireTenantId();
    const pkg = await tx.package.findFirst({ where: { id: input.packageId }, include: { items: true } });
    if (!pkg) throw AppError.notFound('Package');
    if (pkg.status !== 'ACTIVE') throw AppError.invalidState(`${pkg.name} is no longer on sale.`);
    return tx.customerPackage.create({
      data: {
        tenantId,
        customerId: input.customerId,
        packageId: pkg.id,
        branchId: input.branchId,
        purchaseInvoiceId: input.invoiceId,
        expiresAt: addDays(new Date(), pkg.validityDays),
        status: 'PENDING_PAYMENT',
        items: { create: pkg.items.map((i) => ({ serviceId: i.serviceId, totalQuantity: i.quantity })) },
      },
    });
  }

  /** Validity starts on the day the package is paid for. */
  async activateForInvoice(tx: DbOrTx, invoiceId: string, paidAt = new Date()) {
    const pending = await tx.customerPackage.findMany({ where: { purchaseInvoiceId: invoiceId, status: 'PENDING_PAYMENT' }, include: { package: true } });
    for (const cp of pending) {
      await tx.customerPackage.update({ where: { id: cp.id }, data: { status: 'ACTIVE', purchasedAt: paidAt, expiresAt: addDays(paidAt, cp.package.validityDays) } });
      await this.activity.record({ customerId: cp.customerId, branchId: cp.branchId, type: 'PACKAGE_PURCHASED', title: `Bought ${cp.package.name}`, refType: 'CustomerPackage', refId: cp.id, occurredAt: paidAt }, tx);
      await this.events.publish(DomainEvents.PACKAGE_PURCHASED, { customerPackageId: cp.id, customerId: cp.customerId, packageId: cp.packageId, branchId: cp.branchId, invoiceId }, tx);
    }
    return pending.length;
  }

  async cancelForInvoice(tx: DbOrTx, invoiceId: string, onlyUnused = false) {
    const rows = await tx.customerPackage.findMany({ where: { purchaseInvoiceId: invoiceId, status: { in: ['PENDING_PAYMENT', 'ACTIVE'] } }, include: { items: true } });
    for (const cp of rows) {
      if (onlyUnused && cp.items.some((i) => i.usedQuantity > 0)) continue;
      await tx.customerPackage.update({ where: { id: cp.id }, data: { status: 'CANCELLED' } });
    }
  }

  /**
   * Redeems sessions from a customer package (spec section 72). The package item row is locked
   * FOR UPDATE so concurrent redemptions cannot overdraw it, and a redemption tied to a session
   * is recorded at most once, which makes the session.completed handler and POS checkout safe
   * to race each other.
   */
  async redeem(input: RedeemInput, client?: DbOrTx) {
    const run = async (tx: DbOrTx) => {
      const quantity = input.quantity ?? 1;
      const cp = await tx.customerPackage.findFirst({ where: { id: input.customerPackageId }, include: { items: true, package: { select: { name: true } } } });
      if (!cp) throw AppError.notFound('Customer package');
      const item = cp.items.find((i) => i.serviceId === input.serviceId);
      if (!item) throw AppError.badRequest(ErrorCode.PACKAGE_SERVICE_NOT_INCLUDED, `${cp.package.name} does not include this service.`);

      await tx.$queryRaw`SELECT id FROM customer_package_items WHERE id = ${item.id} FOR UPDATE`;
      if (input.sessionId) {
        const existing = await tx.packageRedemption.findFirst({ where: { sessionId: input.sessionId, customerPackageId: cp.id, reversedAt: null } });
        if (existing) return existing;
      }
      const fresh = await tx.customerPackage.findFirst({ where: { id: cp.id }, select: { status: true, expiresAt: true } });
      const now = input.at ?? new Date();
      if (fresh!.status === 'EXPIRED' || fresh!.expiresAt < now) throw AppError.badRequest(ErrorCode.PACKAGE_EXPIRED, `${cp.package.name} expired on ${fresh!.expiresAt.toDateString()}.`);
      if (fresh!.status === 'EXHAUSTED') throw AppError.badRequest(ErrorCode.PACKAGE_EXHAUSTED, `${cp.package.name} has no sessions left.`);
      if (fresh!.status !== 'ACTIVE') throw AppError.badRequest(ErrorCode.PACKAGE_INACTIVE, `${cp.package.name} is not active (${fresh!.status.toLowerCase().replace('_', ' ')}).`);
      const row = await tx.customerPackageItem.findUnique({ where: { id: item.id } });
      if (row!.totalQuantity - row!.usedQuantity < quantity) throw AppError.badRequest(ErrorCode.PACKAGE_EXHAUSTED, `No ${quantity > 1 ? `${quantity} sessions` : 'sessions'} left for this service in ${cp.package.name}.`);

      await tx.customerPackageItem.update({ where: { id: item.id }, data: { usedQuantity: { increment: quantity } } });
      const redemption = await tx.packageRedemption.create({
        data: {
          tenantId: cp.tenantId,
          branchId: input.branchId,
          customerPackageId: cp.id,
          customerPackageItemId: item.id,
          sessionId: input.sessionId ?? null,
          serviceId: input.serviceId,
          quantity,
          redeemedBy: RequestContext.userId ?? null,
          redeemedAt: now,
        },
      });
      const items = await tx.customerPackageItem.findMany({ where: { customerPackageId: cp.id } });
      if (items.every((i) => i.usedQuantity >= i.totalQuantity)) await tx.customerPackage.update({ where: { id: cp.id }, data: { status: 'EXHAUSTED' } });

      const unitValue = await this.unitValue(tx, cp.id, cp.purchaseInvoiceId);
      if (unitValue > 0) await this.ledger.recognisePackageRevenue(tx, { redemptionId: redemption.id, branchId: input.branchId, amount: round2(unitValue * quantity), entryDate: now });
      await this.events.publish(DomainEvents.PACKAGE_REDEEMED, { customerPackageId: cp.id, redemptionId: redemption.id, customerId: cp.customerId, serviceId: input.serviceId, sessionId: input.sessionId ?? null, branchId: input.branchId, quantity }, tx);
      return redemption;
    };
    return client ? run(client) : this.db.$transaction(run);
  }

  /** Deferred revenue released per redeemed session: the package's net sale value over its total sessions. */
  private async unitValue(tx: DbOrTx, customerPackageId: string, invoiceId: string | null) {
    if (!invoiceId) return 0;
    const line = await tx.invoiceItem.findFirst({ where: { invoiceId, customerPackageId } });
    if (!line) return 0;
    const items = await tx.customerPackageItem.findMany({ where: { customerPackageId }, select: { totalQuantity: true } });
    const units = items.reduce((s, i) => s + i.totalQuantity, 0);
    return units ? round2((num(line.total) - num(line.tax)) / units) : 0;
  }

  async reverse(redemptionId: string, reason: string, client?: DbOrTx) {
    const run = async (tx: DbOrTx) => {
      const r = await tx.packageRedemption.findFirst({ where: { id: redemptionId } });
      if (!r) throw AppError.notFound('Redemption');
      if (r.reversedAt) return r;
      await tx.$queryRaw`SELECT id FROM customer_package_items WHERE id = ${r.customerPackageItemId} FOR UPDATE`;
      const updated = await tx.packageRedemption.update({ where: { id: r.id }, data: { reversedAt: new Date() } });
      await tx.customerPackageItem.update({ where: { id: r.customerPackageItemId }, data: { usedQuantity: { decrement: r.quantity } } });
      await tx.customerPackage.updateMany({ where: { id: r.customerPackageId, status: 'EXHAUSTED' }, data: { status: 'ACTIVE' } });
      await this.ledger.reverse(tx, 'PACKAGE_REDEMPTION', r.id, `Redemption reversed: ${reason}`);
      return updated;
    };
    const res = client ? await run(client) : await this.db.$transaction(run);
    await this.audit.log({ action: 'PACKAGE_REDEMPTION_REVERSED', entityType: 'PackageRedemption', entityId: redemptionId, newValues: { reason } });
    return res;
  }

  /** A completed session linked to a package consumes one unit, exactly once per session. */
  @OnDomainEvent('session.completed')
  async onSessionCompleted(payload: Record<string, any>) {
    if (!payload.customerPackageId) return;
    try {
      return await this.redeem({
        customerPackageId: payload.customerPackageId,
        serviceId: payload.serviceId,
        sessionId: payload.sessionId,
        branchId: payload.branchId,
        at: payload.completedAt ? new Date(payload.completedAt) : undefined,
      });
    } catch (e) {
      // Business rejections (expired, exhausted...) are final; the session is simply billed normally.
      if (e instanceof AppError && e.status < 500) {
        this.logger.warn(`Package redemption skipped for session ${payload.sessionId}: ${e.message}`);
        return;
      }
      throw e;
    }
  }

  /** Marks lapsed packages EXPIRED; run daily by the scheduler. */
  async expireDue(now = new Date()) {
    const res = await this.db.customerPackage.updateMany({ where: { status: 'ACTIVE', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
    return res.count;
  }
}
