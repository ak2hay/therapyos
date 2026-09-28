import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';
import { InventoryService } from '../inventory/inventory.service';

const PAID = Prisma.sql`('SUCCESS','PARTIALLY_REFUNDED','REFUNDED')`;
const LIVE = Prisma.sql`status NOT IN ('CANCELLED','DRAFT')`;
const n = (v: unknown) => num(v as number);
const change = (now: number, before: number) => (before ? round2(((now - before) / before) * 100) : null);

interface Win {
  tenantId: string;
  tz: string;
  branches: string[] | undefined;
  todayStart: Date;
  todayEnd: Date;
  monthStart: Date;
  /** Same elapsed span of last month, for like-for-like comparison. */
  prevStart: Date;
  prevEnd: Date;
  now: Date;
}

/** Role dashboards: small, fast aggregates for "today" and "this month". */
@Injectable()
export class DashboardService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
  ) {}

  private async win(branchId?: string): Promise<Win> {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const now = DateTime.now().setZone(tz);
    const monthStart = now.startOf('month');
    const prevStart = monthStart.minus({ months: 1 });
    return {
      tenantId,
      tz,
      branches: RequestContext.branchScope(branchId),
      todayStart: now.startOf('day').toJSDate(),
      todayEnd: now.endOf('day').toJSDate(),
      monthStart: monthStart.toJSDate(),
      prevStart: prevStart.toJSDate(),
      prevEnd: DateTime.min(prevStart.plus(now.diff(monthStart)), monthStart)!.toJSDate(),
      now: now.toJSDate(),
    };
  }

  private b(w: Win, col = '"branchId"') {
    return w.branches ? Prisma.sql`AND ${Prisma.raw(col)} = ANY(${w.branches}::text[])` : Prisma.empty;
  }

  private async billed(w: Win, from: Date, to: Date) {
    const [r] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(total),0) AS total, coalesce(sum(total - tax),0) AS net, count(*)::int AS invoices
      FROM invoices WHERE "tenantId" = ${w.tenantId} AND ${LIVE} AND "issuedAt" BETWEEN ${from} AND ${to} ${this.b(w)}`;
    return { total: round2(n(r.total)), net: round2(n(r.net)), invoices: n(r.invoices) };
  }

  private async collected(w: Win, from: Date, to: Date) {
    const [r] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(amount - "refundedAmount"),0) AS amount FROM payments
      WHERE "tenantId" = ${w.tenantId} AND status IN ${PAID} AND "paidAt" BETWEEN ${from} AND ${to} ${this.b(w)}`;
    return round2(n(r.amount));
  }

  private async outstanding(w: Win) {
    const [r] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(total - ("amountPaid" - "amountRefunded")),0) AS due, count(*)::int AS invoices
      FROM invoices WHERE "tenantId" = ${w.tenantId} AND status IN ('ISSUED','PARTIALLY_PAID') ${this.b(w)}`;
    return { amount: round2(n(r.due)), invoices: n(r.invoices) };
  }

  /** Owner and branch-manager view (branch managers are simply scoped to their branches). */
  async overview(branchId?: string) {
    const w = await this.win(branchId);
    const [today, mtd, prev, collectedToday, collectedMtd, outstanding] = await Promise.all([
      this.billed(w, w.todayStart, w.todayEnd),
      this.billed(w, w.monthStart, w.now),
      this.billed(w, w.prevStart, w.prevEnd),
      this.collected(w, w.todayStart, w.todayEnd),
      this.collected(w, w.monthStart, w.now),
      this.outstanding(w),
    ]);
    const trendStart = DateTime.fromJSDate(w.todayStart, { zone: w.tz }).minus({ days: 29 }).toJSDate();
    const [trendRows, sessionsToday, apptsToday, newCustomers, prevNewCustomers, topServices, branches, rating, expiring, lowStock] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT to_char("issuedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${w.tz}, 'YYYY-MM-DD') AS day, sum(total) AS billed, count(*)::int AS invoices
        FROM invoices WHERE "tenantId" = ${w.tenantId} AND ${LIVE} AND "issuedAt" BETWEEN ${trendStart} AND ${w.todayEnd} ${this.b(w)} GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${w.todayStart})::int AS completed,
               count(*) FILTER (WHERE status IN ('IN_PROGRESS','PAUSED'))::int AS running
        FROM therapy_sessions WHERE "tenantId" = ${w.tenantId} AND ("completedAt" >= ${w.todayStart} OR status IN ('IN_PROGRESS','PAUSED')) ${this.b(w)}`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('BOOKED','CONFIRMED') AND "startTime" > now())::int AS upcoming,
               count(*) FILTER (WHERE status = 'NO_SHOW')::int AS "noShow"
        FROM appointments WHERE "tenantId" = ${w.tenantId} AND "startTime" BETWEEN ${w.todayStart} AND ${w.todayEnd} AND status <> 'CANCELLED' ${this.b(w)}`,
      this.db.customer.count({ where: { createdAt: { gte: w.monthStart }, ...(w.branches ? { OR: [{ primaryBranchId: null }, { primaryBranchId: { in: w.branches } }] } : {}) } }),
      this.db.customer.count({ where: { createdAt: { gte: w.prevStart, lte: w.prevEnd }, ...(w.branches ? { OR: [{ primaryBranchId: null }, { primaryBranchId: { in: w.branches } }] } : {}) } }),
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT it.description AS name, sum(it.quantity)::int AS qty, sum(it.total - it.tax) AS revenue
        FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
        WHERE i."tenantId" = ${w.tenantId} AND i.status NOT IN ('CANCELLED','DRAFT') AND it."itemType" = 'SERVICE' AND i."issuedAt" >= ${w.monthStart} ${this.b(w, 'i."branchId"')}
        GROUP BY 1 ORDER BY 3 DESC LIMIT 5`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT b.id, b.name, coalesce(sum(i.total),0) AS billed, count(i.id)::int AS invoices
        FROM branches b LEFT JOIN invoices i ON i."branchId" = b.id AND i.status NOT IN ('CANCELLED','DRAFT') AND i."issuedAt" >= ${w.monthStart}
        WHERE b."tenantId" = ${w.tenantId} AND b.status = 'ACTIVE' ${this.b(w, 'b.id')}
        GROUP BY b.id ORDER BY 3 DESC`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT avg(rating)::float AS avg, count(*)::int AS count FROM feedback
        WHERE "tenantId" = ${w.tenantId} AND "createdAt" >= ${DateTime.fromJSDate(w.now).minus({ days: 30 }).toJSDate()} ${this.b(w)}`,
      this.db.customerPackage.count({ where: { status: 'ACTIVE', expiresAt: { gte: w.now, lte: DateTime.fromJSDate(w.now).plus({ days: 14 }).toJSDate() }, ...(w.branches ? { branchId: { in: w.branches } } : {}) } }),
      this.inventory.lowStock(branchId).catch(() => []),
    ]);
    const byDay = new Map(trendRows.map((r) => [String(r.day), r]));
    const trend = Array.from({ length: 30 }, (_, i) => {
      const day = DateTime.fromJSDate(trendStart, { zone: w.tz }).plus({ days: i }).toFormat('yyyy-MM-dd');
      return { day, billed: round2(n(byDay.get(day)?.billed)), invoices: n(byDay.get(day)?.invoices) };
    });
    return {
      today: { billed: today.total, invoices: today.invoices, collected: collectedToday, sessionsCompleted: n(sessionsToday[0]?.completed), sessionsRunning: n(sessionsToday[0]?.running), appointments: n(apptsToday[0]?.total), upcoming: n(apptsToday[0]?.upcoming), noShows: n(apptsToday[0]?.noShow) },
      month: { billed: mtd.total, net: mtd.net, invoices: mtd.invoices, collected: collectedMtd, change: change(mtd.total, prev.total), newCustomers, newCustomersChange: change(newCustomers, prevNewCustomers), avgBill: mtd.invoices ? round2(mtd.total / mtd.invoices) : 0 },
      outstanding,
      rating: { avg: rating[0]?.avg ? round2(n(rating[0].avg)) : null, count: n(rating[0]?.count) },
      trend,
      topServices: topServices.map((r) => ({ name: String(r.name), qty: n(r.qty), revenue: round2(n(r.revenue)) })),
      branches: branches.map((r) => ({ id: String(r.id), name: String(r.name), billed: round2(n(r.billed)), invoices: n(r.invoices) })),
      alerts: {
        lowStock: lowStock.slice(0, 8).map((s) => ({ product: s.product.name, branch: s.branch.name, quantity: num(s.quantity), reorderLevel: num(s.reorderLevel), unit: s.product.unit })),
        lowStockCount: lowStock.length,
        expiringPackages: expiring,
      },
    };
  }

  /** Reception: what needs attention at the desk right now. */
  async frontDesk(branchId?: string) {
    const w = await this.win(branchId);
    const soon = DateTime.fromJSDate(w.now).plus({ hours: 2 }).toJSDate();
    const branchWhere = w.branches ? { branchId: { in: w.branches } } : {};
    const [appointments, upcoming, queue, running, unbilled, unpaid, today] = await Promise.all([
      this.db.appointment.groupBy({ by: ['status'], where: { startTime: { gte: w.todayStart, lte: w.todayEnd }, ...branchWhere }, _count: { _all: true } }),
      this.db.appointment.findMany({
        where: { startTime: { gte: w.now, lte: soon }, status: { in: ['BOOKED', 'CONFIRMED'] }, ...branchWhere },
        include: { customer: { select: { id: true, name: true } }, service: { select: { name: true } }, therapist: { select: { name: true } } },
        orderBy: { startTime: 'asc' },
        take: 10,
      }),
      this.db.queueEntry.count({ where: { status: 'WAITING', queueDate: dateOnly(DateTime.fromJSDate(w.now, { zone: w.tz }).toISODate()!), ...branchWhere } }),
      this.db.therapySession.findMany({
        where: { status: { in: ['IN_PROGRESS', 'PAUSED'] }, ...branchWhere },
        include: { customer: { select: { name: true } }, service: { select: { name: true, durationMinutes: true } }, therapist: { select: { name: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      this.db.therapySession.findMany({
        where: { status: 'COMPLETED', invoiceId: null, completedAt: { gte: DateTime.fromJSDate(w.now).minus({ days: 3 }).toJSDate() }, ...branchWhere },
        include: { customer: { select: { id: true, name: true } }, service: { select: { name: true } }, therapist: { select: { name: true } } },
        orderBy: { completedAt: 'desc' },
        take: 15,
      }),
      this.db.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, ...branchWhere },
        select: { id: true, invoiceNumber: true, total: true, amountPaid: true, amountRefunded: true, issuedAt: true, customer: { select: { name: true } } },
        orderBy: { issuedAt: 'desc' },
        take: 10,
      }),
      this.collected(w, w.todayStart, w.todayEnd),
    ]);
    const counts = Object.fromEntries(appointments.map((a) => [a.status, a._count._all]));
    return {
      appointments: { total: appointments.reduce((t, a) => t + (a.status === 'CANCELLED' ? 0 : a._count._all), 0), byStatus: counts },
      waiting: queue,
      collectedToday: today,
      upcoming: upcoming.map((a) => ({ id: a.id, startTime: a.startTime, status: a.status, customer: a.customer, service: a.service.name, therapist: a.therapist?.name ?? null })),
      running: running.map((s) => ({ id: s.id, status: s.status, startedAt: s.startedAt, customer: s.customer.name, service: s.service.name, durationMinutes: s.service.durationMinutes, therapist: s.therapist.name, room: s.room })),
      unbilled: unbilled.map((s) => ({ id: s.id, completedAt: s.completedAt, customer: s.customer, service: s.service.name, therapist: s.therapist.name })),
      unpaid: unpaid.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer?.name ?? null, issuedAt: i.issuedAt, due: round2(num(i.total) - (num(i.amountPaid) - num(i.amountRefunded))) })),
    };
  }

  /** Therapist: their own day and month. */
  async therapist() {
    const therapistId = RequestContext.get('therapistId');
    if (!therapistId) throw AppError.forbidden('This dashboard is for therapist accounts.');
    const w = await this.win();
    const [today, month, rating, commission, recentFeedback, nextUp] = await Promise.all([
      this.db.therapySession.findMany({
        where: { therapistId, OR: [{ completedAt: { gte: w.todayStart, lte: w.todayEnd } }, { status: { in: ['SCHEDULED', 'IN_PROGRESS', 'PAUSED'] } }] },
        include: { customer: { select: { name: true } }, service: { select: { name: true, durationMinutes: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.therapySession.count({ where: { therapistId, status: 'COMPLETED', completedAt: { gte: w.monthStart } } }),
      this.db.feedback.aggregate({ where: { therapistId, createdAt: { gte: DateTime.fromJSDate(w.now).minus({ days: 90 }).toJSDate() } }, _avg: { rating: true }, _count: { _all: true } }),
      this.db.therapistCommission.aggregate({ where: { therapistId, createdAt: { gte: w.monthStart } }, _sum: { amount: true } }),
      this.db.feedback.findMany({ where: { therapistId, comment: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5, select: { rating: true, comment: true, createdAt: true } }),
      this.db.appointment.findMany({
        where: { therapistId, startTime: { gte: w.now, lte: w.todayEnd }, status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN'] } },
        include: { customer: { select: { name: true } }, service: { select: { name: true } } },
        orderBy: { startTime: 'asc' },
        take: 8,
      }),
    ]);
    return {
      today: {
        completed: today.filter((s) => s.status === 'COMPLETED').length,
        sessions: today.map((s) => ({ id: s.id, status: s.status, startedAt: s.startedAt, completedAt: s.completedAt, customer: s.customer.name, service: s.service.name, durationMinutes: s.service.durationMinutes, room: s.room })),
      },
      month: { sessions: month, commission: round2(num(commission._sum.amount)) },
      rating: { avg: rating._avg.rating ? round2(rating._avg.rating) : null, count: rating._count._all },
      recentFeedback,
      upcoming: nextUp.map((a) => ({ id: a.id, startTime: a.startTime, status: a.status, customer: a.customer.name, service: a.service.name })),
    };
  }

  /** Accountant: cash position, receivables and spend. */
  async accounts(branchId?: string) {
    const w = await this.win(branchId);
    const [methodsToday, methodsMonth, outstanding, aging, expenses, refunds, mtd] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT method, sum(amount - "refundedAmount") AS amount, count(*)::int AS count FROM payments
        WHERE "tenantId" = ${w.tenantId} AND status IN ${PAID} AND "paidAt" BETWEEN ${w.todayStart} AND ${w.todayEnd} ${this.b(w)} GROUP BY 1 ORDER BY 2 DESC`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT method, sum(amount - "refundedAmount") AS amount, count(*)::int AS count FROM payments
        WHERE "tenantId" = ${w.tenantId} AND status IN ${PAID} AND "paidAt" >= ${w.monthStart} ${this.b(w)} GROUP BY 1 ORDER BY 2 DESC`,
      this.outstanding(w),
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT CASE WHEN "issuedAt" > now() - interval '7 days' THEN '0-7 days'
                    WHEN "issuedAt" > now() - interval '30 days' THEN '8-30 days'
                    WHEN "issuedAt" > now() - interval '60 days' THEN '31-60 days' ELSE '60+ days' END AS bucket,
               sum(total - ("amountPaid" - "amountRefunded")) AS due, count(*)::int AS invoices
        FROM invoices WHERE "tenantId" = ${w.tenantId} AND status IN ('ISSUED','PARTIALLY_PAID') ${this.b(w)} GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT category, sum(amount) AS amount FROM expenses
        WHERE "tenantId" = ${w.tenantId} AND "expenseDate" >= ${DateTime.fromJSDate(w.monthStart, { zone: w.tz }).toISODate()}::date ${this.b(w)} GROUP BY 1 ORDER BY 2 DESC`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT coalesce(sum(amount),0) AS amount, count(*)::int AS count FROM refunds
        WHERE "tenantId" = ${w.tenantId} AND status = 'SUCCESS' AND "createdAt" >= ${w.monthStart} ${this.b(w)}`,
      this.billed(w, w.monthStart, w.now),
    ]);
    const order = ['0-7 days', '8-30 days', '31-60 days', '60+ days'];
    const spend = round2(expenses.reduce((t, r) => t + n(r.amount), 0));
    const collectedMonth = round2(methodsMonth.reduce((t, r) => t + n(r.amount), 0));
    return {
      today: { collected: round2(methodsToday.reduce((t, r) => t + n(r.amount), 0)), byMethod: methodsToday.map((r) => ({ method: String(r.method), amount: round2(n(r.amount)), count: n(r.count) })) },
      month: {
        billed: mtd.total,
        net: mtd.net,
        collected: collectedMonth,
        byMethod: methodsMonth.map((r) => ({ method: String(r.method), amount: round2(n(r.amount)), count: n(r.count) })),
        refunds: { amount: round2(n(refunds[0]?.amount)), count: n(refunds[0]?.count) },
        expenses: { total: spend, byCategory: expenses.map((r) => ({ category: String(r.category), amount: round2(n(r.amount)) })) },
        cashSurplus: round2(collectedMonth - spend - n(refunds[0]?.amount)),
      },
      outstanding,
      aging: order.map((bucket) => {
        const r = aging.find((a) => a.bucket === bucket);
        return { bucket, due: round2(n(r?.due)), invoices: n(r?.invoices) };
      }),
    };
  }
}
