import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReportQuery } from '@therapyos/validation';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';
import { Report, ReportKey, REPORTS, ReportTable } from './report-types';

interface Ctx {
  tenantId: string;
  tz: string;
  start: Date;
  end: Date;
  from: string;
  to: string;
  branches: string[] | undefined;
  groupBy: 'day' | 'week' | 'month';
}

const PAID = Prisma.sql`('SUCCESS','PARTIALLY_REFUNDED','REFUNDED')`;
const LIVE_INVOICE = Prisma.sql`i.status NOT IN ('CANCELLED','DRAFT')`;
const pct = (a: number, b: number) => (b ? round2((a / b) * 100) : 0);
const n = (v: unknown) => num(v as number);

/**
 * Reporting runs read-only SQL aggregates (the tenant filter is explicit because raw queries
 * bypass the tenant extension). Dates are bucketed in the tenant's timezone.
 */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async run(key: string, q: ReportQuery): Promise<Report> {
    if (!(key in REPORTS)) throw AppError.notFound('Report');
    const meta = REPORTS[key as ReportKey];
    if (meta.financial && !RequestContext.hasPermission('reports.financial')) throw AppError.forbidden('Financial reports need the reports.financial permission.');
    const ctx = await this.ctx(q);
    const body = await this[key as ReportKey](ctx);
    return { key, title: meta.title, from: q.from, to: q.to, branchId: q.branchId ?? null, ...body };
  }

  private async ctx(q: ReportQuery): Promise<Ctx> {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const start = DateTime.fromISO(q.from, { zone: tz }).startOf('day');
    const end = DateTime.fromISO(q.to, { zone: tz }).endOf('day');
    if (!start.isValid || !end.isValid || end < start) throw AppError.validation('Choose a valid date range.');
    if (end.diff(start, 'days').days > 731) throw AppError.validation('Reports cover at most two years at a time.');
    return { tenantId, tz, start: start.toJSDate(), end: end.toJSDate(), from: q.from, to: q.to, branches: RequestContext.branchScope(q.branchId), groupBy: q.groupBy };
  }

  private branch(ctx: Ctx, col: string) {
    return ctx.branches ? Prisma.sql`AND ${Prisma.raw(col)} = ANY(${ctx.branches}::text[])` : Prisma.empty;
  }

  private bucket(ctx: Ctx, col: string) {
    return Prisma.sql`to_char(date_trunc(${ctx.groupBy}, ${Prisma.raw(col)} AT TIME ZONE 'UTC' AT TIME ZONE ${ctx.tz}), 'YYYY-MM-DD')`;
  }

  /** Every period in range, so charts show gaps as zero instead of skipping them. */
  private periods(ctx: Ctx): string[] {
    const unit = ctx.groupBy;
    const out: string[] = [];
    let d = DateTime.fromJSDate(ctx.start, { zone: ctx.tz }).startOf(unit);
    const last = DateTime.fromJSDate(ctx.end, { zone: ctx.tz });
    while (d <= last && out.length < 800) {
      out.push(d.toFormat('yyyy-MM-dd'));
      d = d.plus({ [`${unit}s`]: 1 });
    }
    return out;
  }

  private fill(ctx: Ctx, rows: Record<string, unknown>[], keys: string[]): Array<Record<string, number> & { period: string }> {
    const byPeriod = new Map(rows.map((r) => [String(r.period), r]));
    return this.periods(ctx).map((period) => {
      const r = byPeriod.get(period);
      return { ...Object.fromEntries(keys.map((k) => [k, round2(n(r?.[k]))])), period } as Record<string, number> & { period: string };
    });
  }

  // ---------- sales ----------

  private async sales(ctx: Ctx) {
    const [inv] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*)::int AS invoices, coalesce(sum(subtotal),0) AS subtotal, coalesce(sum(discount),0) AS discount,
             coalesce(sum(tax),0) AS tax, coalesce(sum(total),0) AS total, count(DISTINCT "customerId")::int AS customers
      FROM invoices i WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE}
        AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}`;
    const [pay] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(amount),0) AS collected FROM payments p
      WHERE p."tenantId" = ${ctx.tenantId} AND p.status IN ${PAID} AND p."paidAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'p."branchId"')}`;
    const [ref] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(amount),0) AS refunded FROM refunds r
      WHERE r."tenantId" = ${ctx.tenantId} AND r.status = 'SUCCESS' AND r."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'r."branchId"')}`;
    const billed = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'i."issuedAt"')} AS period, sum(total) AS billed, sum(total - tax) AS net
      FROM invoices i WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY 1`;
    const collected = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'p."paidAt"')} AS period, sum(amount) AS collected
      FROM payments p WHERE p."tenantId" = ${ctx.tenantId} AND p.status IN ${PAID} AND p."paidAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'p."branchId"')}
      GROUP BY 1`;
    const byType = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT it."itemType" AS type, sum(it.quantity)::int AS qty, sum(it.total - it.tax) AS net, sum(it.discount) AS discount
      FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY 1 ORDER BY 3 DESC`;
    const byMethod = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT p.method, count(*)::int AS count, sum(amount) AS amount, sum("refundedAmount") AS refunded
      FROM payments p WHERE p."tenantId" = ${ctx.tenantId} AND p.status IN ${PAID} AND p."paidAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'p."branchId"')}
      GROUP BY 1 ORDER BY 3 DESC`;
    const byBranch = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT b.name AS branch, count(i.id)::int AS invoices, coalesce(sum(i.total),0) AS billed, coalesce(sum(i.total - i.tax),0) AS net, coalesce(sum(i."amountPaid" - i."amountRefunded"),0) AS collected
      FROM invoices i JOIN branches b ON b.id = i."branchId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY b.name ORDER BY 3 DESC`;

    const merged = new Map<string, Record<string, unknown>>();
    for (const r of billed) merged.set(String(r.period), { ...r });
    for (const r of collected) merged.set(String(r.period), { ...(merged.get(String(r.period)) ?? { period: r.period }), collected: r.collected });
    const points = this.fill(ctx, [...merged.values()], ['billed', 'net', 'collected']);
    const total = n(inv.total);
    return {
      metrics: [
        { key: 'billed', label: 'Billed', value: round2(total), type: 'money' as const, hint: `${inv.invoices} invoices` },
        { key: 'net', label: 'Net sales (ex tax)', value: round2(total - n(inv.tax)), type: 'money' as const },
        { key: 'collected', label: 'Collected', value: round2(n(pay.collected)), type: 'money' as const },
        { key: 'refunded', label: 'Refunded', value: round2(n(ref.refunded)), type: 'money' as const },
        { key: 'discount', label: 'Discounts', value: round2(n(inv.discount)), type: 'money' as const },
        { key: 'tax', label: 'Tax collected', value: round2(n(inv.tax)), type: 'money' as const },
        { key: 'avg', label: 'Average bill', value: n(inv.invoices) ? round2(total / n(inv.invoices)) : 0, type: 'money' as const, hint: `${inv.customers} customers` },
      ],
      series: { title: 'Billed vs collected', lines: [{ key: 'billed', label: 'Billed', type: 'money' as const }, { key: 'collected', label: 'Collected', type: 'money' as const }], points },
      tables: [
        {
          key: 'trend',
          title: 'By period',
          columns: [{ key: 'period', label: 'Period', type: 'date' as const }, { key: 'billed', label: 'Billed', type: 'money' as const }, { key: 'net', label: 'Net (ex tax)', type: 'money' as const }, { key: 'collected', label: 'Collected', type: 'money' as const }],
          rows: points,
        },
        {
          key: 'types',
          title: 'By item type',
          columns: [{ key: 'type', label: 'Type' }, { key: 'qty', label: 'Qty', type: 'number' as const }, { key: 'net', label: 'Net sales', type: 'money' as const }, { key: 'discount', label: 'Discounts', type: 'money' as const }, { key: 'share', label: 'Share', type: 'percent' as const }],
          rows: byType.map((r) => ({ type: String(r.type), qty: n(r.qty), net: round2(n(r.net)), discount: round2(n(r.discount)), share: pct(n(r.net), total - n(inv.tax)) })),
        },
        {
          key: 'methods',
          title: 'By payment method',
          columns: [{ key: 'method', label: 'Method' }, { key: 'count', label: 'Payments', type: 'number' as const }, { key: 'amount', label: 'Collected', type: 'money' as const }, { key: 'refunded', label: 'Refunded', type: 'money' as const }, { key: 'net', label: 'Net', type: 'money' as const }],
          rows: byMethod.map((r) => ({ method: String(r.method), count: n(r.count), amount: round2(n(r.amount)), refunded: round2(n(r.refunded)), net: round2(n(r.amount) - n(r.refunded)) })),
        },
        {
          key: 'branches',
          title: 'By branch',
          columns: [{ key: 'branch', label: 'Branch' }, { key: 'invoices', label: 'Invoices', type: 'number' as const }, { key: 'billed', label: 'Billed', type: 'money' as const }, { key: 'net', label: 'Net (ex tax)', type: 'money' as const }, { key: 'collected', label: 'Collected', type: 'money' as const }],
          rows: byBranch.map((r) => ({ branch: String(r.branch), invoices: n(r.invoices), billed: round2(n(r.billed)), net: round2(n(r.net)), collected: round2(n(r.collected)) })),
        },
      ],
    };
  }

  // ---------- services ----------

  private async services(ctx: Ctx) {
    const sessions = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT s."serviceId" AS id, count(*)::int AS sessions, avg(f.rating)::float AS rating, count(f.id)::int AS ratings,
             avg(EXTRACT(EPOCH FROM (s."completedAt" - s."startedAt")) - s."totalPausedSeconds")::float / 60 AS minutes
      FROM therapy_sessions s LEFT JOIN feedback f ON f."sessionId" = s.id
      WHERE s."tenantId" = ${ctx.tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 's."branchId"')}
      GROUP BY 1`;
    const sales = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT it."itemId" AS id, sum(it.quantity)::int AS billed, sum(it.total - it.tax) AS revenue, sum(it.discount) AS discount
      FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND it."itemType" = 'SERVICE' AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY 1`;
    const services = await this.db.service.findMany({ select: { id: true, name: true, durationMinutes: true, category: { select: { name: true } } } });
    const s = new Map(sessions.map((r) => [String(r.id), r]));
    const b = new Map(sales.map((r) => [String(r.id), r]));
    const rows = services
      .map((svc) => {
        const x = s.get(svc.id);
        const y = b.get(svc.id);
        const revenue = round2(n(y?.revenue));
        return {
          service: svc.name,
          category: svc.category?.name ?? 'Uncategorised',
          sessions: n(x?.sessions),
          billed: n(y?.billed),
          revenue,
          avgPrice: n(y?.billed) ? round2(revenue / n(y?.billed)) : 0,
          discount: round2(n(y?.discount)),
          avgMinutes: x?.minutes ? Math.round(n(x.minutes)) : null,
          rating: x?.rating ? round2(n(x.rating)) : null,
        };
      })
      .filter((r) => r.sessions || r.billed)
      .sort((a, b2) => b2.revenue - a.revenue);
    const totalRevenue = rows.reduce((t, r) => t + r.revenue, 0);
    return {
      metrics: [
        { key: 'sessions', label: 'Sessions completed', value: rows.reduce((t, r) => t + r.sessions, 0), type: 'number' as const },
        { key: 'revenue', label: 'Service revenue (ex tax)', value: round2(totalRevenue), type: 'money' as const },
        { key: 'services', label: 'Services sold', value: rows.length, type: 'number' as const },
        { key: 'top', label: rows[0] ? `Top: ${rows[0].service}` : 'Top service', value: rows[0]?.revenue ?? 0, type: 'money' as const },
      ],
      tables: [
        {
          key: 'services',
          title: 'Service performance',
          columns: [
            { key: 'service', label: 'Service' },
            { key: 'category', label: 'Category' },
            { key: 'sessions', label: 'Sessions', type: 'number' as const },
            { key: 'billed', label: 'Billed qty', type: 'number' as const },
            { key: 'revenue', label: 'Revenue', type: 'money' as const },
            { key: 'avgPrice', label: 'Avg price', type: 'money' as const },
            { key: 'discount', label: 'Discounts', type: 'money' as const },
            { key: 'avgMinutes', label: 'Avg minutes', type: 'number' as const },
            { key: 'rating', label: 'Rating', type: 'number' as const },
          ],
          rows,
        },
      ],
    };
  }

  // ---------- therapists ----------

  private async therapists(ctx: Ctx) {
    const sessions = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT s."therapistId" AS id, count(*)::int AS sessions, count(DISTINCT s."customerId")::int AS customers,
             sum(greatest(0, EXTRACT(EPOCH FROM (s."completedAt" - s."startedAt")) - s."totalPausedSeconds"))::float / 3600 AS hours
      FROM therapy_sessions s
      WHERE s."tenantId" = ${ctx.tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 's."branchId"')}
      GROUP BY 1`;
    const revenue = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(it."therapistId", s."therapistId") AS id, sum(it.total - it.tax) AS revenue
      FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
      LEFT JOIN therapy_sessions s ON s.id = it."sessionId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND coalesce(it."therapistId", s."therapistId") IS NOT NULL AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY 1`;
    const ratings = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT f."therapistId" AS id, avg(f.rating)::float AS rating, count(*)::int AS ratings
      FROM feedback f WHERE f."tenantId" = ${ctx.tenantId} AND f."therapistId" IS NOT NULL AND f."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'f."branchId"')}
      GROUP BY 1`;
    const commissions = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT c."therapistId" AS id, sum(c.amount) AS commission
      FROM therapist_commissions c WHERE c."tenantId" = ${ctx.tenantId} AND c."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'c."branchId"')}
      GROUP BY 1`;
    const therapists = await this.db.therapist.findMany({ select: { id: true, name: true, employeeCode: true } });
    const maps = [sessions, revenue, ratings, commissions].map((rows) => new Map(rows.map((r) => [String(r.id), r])));
    const rows = therapists
      .map((t) => {
        const [s, r, f, c] = maps.map((m) => m.get(t.id));
        return {
          therapist: t.name,
          code: t.employeeCode,
          sessions: n(s?.sessions),
          customers: n(s?.customers),
          hours: round2(n(s?.hours)),
          revenue: round2(n(r?.revenue)),
          perSession: n(s?.sessions) ? round2(n(r?.revenue) / n(s?.sessions)) : 0,
          commission: round2(n(c?.commission)),
          rating: f?.rating ? round2(n(f.rating)) : null,
          ratings: n(f?.ratings),
        };
      })
      .filter((r) => r.sessions || r.revenue)
      .sort((a, b) => b.revenue - a.revenue);
    const rated = rows.filter((r) => r.rating != null);
    return {
      metrics: [
        { key: 'sessions', label: 'Sessions', value: rows.reduce((t, r) => t + r.sessions, 0), type: 'number' as const },
        { key: 'hours', label: 'Therapy hours', value: round2(rows.reduce((t, r) => t + r.hours, 0)), type: 'number' as const },
        { key: 'revenue', label: 'Attributed revenue', value: round2(rows.reduce((t, r) => t + r.revenue, 0)), type: 'money' as const },
        { key: 'commission', label: 'Commission accrued', value: round2(rows.reduce((t, r) => t + r.commission, 0)), type: 'money' as const },
        { key: 'rating', label: 'Average rating', value: rated.length ? round2(rated.reduce((t, r) => t + (r.rating ?? 0) * r.ratings, 0) / Math.max(1, rated.reduce((t, r) => t + r.ratings, 0))) : 0, type: 'number' as const },
      ],
      tables: [
        {
          key: 'therapists',
          title: 'Therapist performance',
          columns: [
            { key: 'therapist', label: 'Therapist' },
            { key: 'code', label: 'Code' },
            { key: 'sessions', label: 'Sessions', type: 'number' as const },
            { key: 'customers', label: 'Customers', type: 'number' as const },
            { key: 'hours', label: 'Hours', type: 'number' as const },
            { key: 'revenue', label: 'Revenue', type: 'money' as const },
            { key: 'perSession', label: 'Per session', type: 'money' as const },
            { key: 'commission', label: 'Commission', type: 'money' as const },
            { key: 'rating', label: 'Rating', type: 'number' as const },
            { key: 'ratings', label: 'Reviews', type: 'number' as const },
          ],
          rows,
        },
      ],
    };
  }

  // ---------- customers ----------

  private async customers(ctx: Ctx) {
    const primary = ctx.branches ? Prisma.sql`AND (c."primaryBranchId" IS NULL OR c."primaryBranchId" = ANY(${ctx.branches}::text[]))` : Prisma.empty;
    const newBy = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'c."createdAt"')} AS period, count(*)::int AS "newCustomers"
      FROM customers c WHERE c."tenantId" = ${ctx.tenantId} AND c."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${primary}
      GROUP BY 1`;
    const sources = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT c.source, count(*)::int AS customers FROM customers c
      WHERE c."tenantId" = ${ctx.tenantId} AND c."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${primary}
      GROUP BY 1 ORDER BY 2 DESC`;
    const [served] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(DISTINCT s."customerId")::int AS served,
             count(DISTINCT s."customerId") FILTER (WHERE m."firstVisitAt" < ${ctx.start})::int AS returning,
             count(*)::int AS visits
      FROM therapy_sessions s LEFT JOIN customer_metrics m ON m."customerId" = s."customerId"
      WHERE s."tenantId" = ${ctx.tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 's."branchId"')}`;
    const top = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT c.name, c."customerCode" AS code, count(i.id)::int AS invoices, sum(i.total) AS spend, max(i."issuedAt") AS "lastBill"
      FROM invoices i JOIN customers c ON c.id = i."customerId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY c.id ORDER BY 4 DESC LIMIT 50`;
    const segments = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT m.segment, count(*)::int AS customers, coalesce(avg(m."totalSpend"),0) AS "avgSpend", coalesce(avg(m."visitCount"),0)::float AS "avgVisits"
      FROM customer_metrics m JOIN customers c ON c.id = m."customerId"
      WHERE m."tenantId" = ${ctx.tenantId} AND c.status = 'ACTIVE' ${primary}
      GROUP BY 1 ORDER BY 2 DESC`;
    const points = this.fill(ctx, newBy, ['newCustomers']);
    const newTotal = points.reduce((t, p) => t + n(p.newCustomers), 0);
    return {
      metrics: [
        { key: 'new', label: 'New customers', value: newTotal, type: 'number' as const },
        { key: 'served', label: 'Customers served', value: n(served.served), type: 'number' as const, hint: `${served.visits} visits` },
        { key: 'returning', label: 'Returning customers', value: n(served.returning), type: 'number' as const },
        { key: 'retention', label: 'Returning share', value: pct(n(served.returning), n(served.served)), type: 'percent' as const },
      ],
      series: { title: 'New customers', lines: [{ key: 'newCustomers', label: 'New customers', type: 'number' as const }], points },
      tables: [
        {
          key: 'top',
          title: 'Top customers by spend',
          columns: [{ key: 'name', label: 'Customer' }, { key: 'code', label: 'Code' }, { key: 'invoices', label: 'Bills', type: 'number' as const }, { key: 'spend', label: 'Spend', type: 'money' as const }, { key: 'lastBill', label: 'Last bill', type: 'date' as const }],
          rows: top.map((r) => ({ name: String(r.name), code: String(r.code), invoices: n(r.invoices), spend: round2(n(r.spend)), lastBill: r.lastBill ? (r.lastBill as Date).toISOString() : null })),
        },
        {
          key: 'segments',
          title: 'Segments (current)',
          columns: [{ key: 'segment', label: 'Segment' }, { key: 'customers', label: 'Customers', type: 'number' as const }, { key: 'avgSpend', label: 'Avg lifetime spend', type: 'money' as const }, { key: 'avgVisits', label: 'Avg visits', type: 'number' as const }],
          rows: segments.map((r) => ({ segment: String(r.segment), customers: n(r.customers), avgSpend: round2(n(r.avgSpend)), avgVisits: round2(n(r.avgVisits)) })),
        },
        {
          key: 'sources',
          title: 'Where new customers came from',
          columns: [{ key: 'source', label: 'Source' }, { key: 'customers', label: 'Customers', type: 'number' as const }, { key: 'share', label: 'Share', type: 'percent' as const }],
          rows: sources.map((r) => ({ source: String(r.source), customers: n(r.customers), share: pct(n(r.customers), newTotal) })),
        },
      ],
    };
  }

  // ---------- appointments ----------

  private async appointments(ctx: Ctx) {
    const range = Prisma.sql`a."startTime" BETWEEN ${ctx.start} AND ${ctx.end}`;
    const series = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'a."startTime"')} AS period, count(*)::int AS booked,
             count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS "noShow",
             count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled
      FROM appointments a WHERE a."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'a."branchId"')}
      GROUP BY 1`;
    const byStatus = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT a.status, count(*)::int AS count FROM appointments a
      WHERE a."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'a."branchId"')} GROUP BY 1 ORDER BY 2 DESC`;
    const bySource = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT a.source, count(*)::int AS count, count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS "noShow"
      FROM appointments a WHERE a."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'a."branchId"')} GROUP BY 1 ORDER BY 2 DESC`;
    const [walkIns] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*)::int AS count FROM queue_entries q
      WHERE q."tenantId" = ${ctx.tenantId} AND q."appointmentId" IS NULL AND q."checkedInAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'q."branchId"')}`;
    const byHour = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT EXTRACT(HOUR FROM a."startTime" AT TIME ZONE 'UTC' AT TIME ZONE ${ctx.tz})::int AS hour, count(*)::int AS count
      FROM appointments a WHERE a."tenantId" = ${ctx.tenantId} AND ${range} AND a.status <> 'CANCELLED' ${this.branch(ctx, 'a."branchId"')}
      GROUP BY 1 ORDER BY 1`;
    const points = this.fill(ctx, series, ['booked', 'completed', 'noShow', 'cancelled']);
    const total = points.reduce((t, p) => t + n(p.booked), 0);
    const count = (k: string) => points.reduce((t, p) => t + n((p as Record<string, unknown>)[k]), 0);
    return {
      metrics: [
        { key: 'booked', label: 'Appointments', value: total, type: 'number' as const },
        { key: 'completed', label: 'Completed', value: count('completed'), type: 'number' as const },
        { key: 'noShowRate', label: 'No-show rate', value: pct(count('noShow'), total), type: 'percent' as const, hint: `${count('noShow')} no-shows` },
        { key: 'cancelRate', label: 'Cancellation rate', value: pct(count('cancelled'), total), type: 'percent' as const },
        { key: 'walkIns', label: 'Walk-ins (queue)', value: n(walkIns.count), type: 'number' as const },
      ],
      series: {
        title: 'Appointments',
        lines: [{ key: 'booked', label: 'Booked', type: 'number' as const }, { key: 'completed', label: 'Completed', type: 'number' as const }, { key: 'noShow', label: 'No-show', type: 'number' as const }],
        points,
      },
      tables: [
        { key: 'status', title: 'By status', columns: [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Appointments', type: 'number' as const }, { key: 'share', label: 'Share', type: 'percent' as const }], rows: byStatus.map((r) => ({ status: String(r.status), count: n(r.count), share: pct(n(r.count), total) })) },
        { key: 'source', title: 'By booking source', columns: [{ key: 'source', label: 'Source' }, { key: 'count', label: 'Appointments', type: 'number' as const }, { key: 'noShow', label: 'No-shows', type: 'number' as const }, { key: 'noShowRate', label: 'No-show rate', type: 'percent' as const }], rows: bySource.map((r) => ({ source: String(r.source), count: n(r.count), noShow: n(r.noShow), noShowRate: pct(n(r.noShow), n(r.count)) })) },
        { key: 'hours', title: 'Busiest hours', columns: [{ key: 'hour', label: 'Hour' }, { key: 'count', label: 'Appointments', type: 'number' as const }], rows: byHour.map((r) => ({ hour: `${String(r.hour).padStart(2, '0')}:00`, count: n(r.count) })) },
      ],
    };
  }

  // ---------- packages & memberships ----------

  private async packages(ctx: Ctx) {
    const pkg = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT p.name, count(cp.id)::int AS sold,
             count(cp.id) FILTER (WHERE cp.status = 'ACTIVE')::int AS active,
             coalesce((SELECT sum(it.total - it.tax) FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
                       WHERE it."itemType" = 'PACKAGE' AND it."itemId" = p.id AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}), 0) AS revenue
      FROM packages p LEFT JOIN customer_packages cp ON cp."packageId" = p.id AND cp.status NOT IN ('PENDING_PAYMENT','CANCELLED')
           AND cp."purchasedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'cp."branchId"')}
      WHERE p."tenantId" = ${ctx.tenantId}
      GROUP BY p.id ORDER BY 4 DESC`;
    const [redeemed] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(quantity),0)::int AS sessions FROM package_redemptions r
      WHERE r."tenantId" = ${ctx.tenantId} AND r."reversedAt" IS NULL AND r."redeemedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'r."branchId"')}`;
    const [live] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
             count(*) FILTER (WHERE status = 'ACTIVE' AND "expiresAt" < now() + interval '30 days')::int AS expiring
      FROM customer_packages cp WHERE cp."tenantId" = ${ctx.tenantId} ${this.branch(ctx, 'cp."branchId"')}`;
    const plans = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT mp.name, count(cm.id) FILTER (WHERE cm."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} AND cm.status NOT IN ('PENDING_PAYMENT','CANCELLED'))::int AS sold,
             count(cm.id) FILTER (WHERE cm.status = 'ACTIVE')::int AS active,
             count(cm.id) FILTER (WHERE cm.status = 'ACTIVE' AND cm."autoRenew")::int AS "autoRenew",
             coalesce((SELECT sum(it.total - it.tax) FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
                       WHERE it."itemType" = 'MEMBERSHIP' AND it."itemId" = mp.id AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}), 0) AS revenue
      FROM membership_plans mp LEFT JOIN customer_memberships cm ON cm."membershipPlanId" = mp.id ${this.branch(ctx, 'cm."branchId"')}
      WHERE mp."tenantId" = ${ctx.tenantId}
      GROUP BY mp.id ORDER BY 5 DESC`;
    const pkgRows = pkg.map((r) => ({ package: String(r.name), sold: n(r.sold), active: n(r.active), revenue: round2(n(r.revenue)) }));
    const planRows = plans.map((r) => ({ plan: String(r.name), sold: n(r.sold), active: n(r.active), autoRenew: n(r.autoRenew), revenue: round2(n(r.revenue)) }));
    return {
      metrics: [
        { key: 'pkgSold', label: 'Packages sold', value: pkgRows.reduce((t, r) => t + r.sold, 0), type: 'number' as const },
        { key: 'pkgRevenue', label: 'Package sales', value: round2(pkgRows.reduce((t, r) => t + r.revenue, 0)), type: 'money' as const },
        { key: 'redeemed', label: 'Sessions redeemed', value: n(redeemed.sessions), type: 'number' as const },
        { key: 'expiring', label: 'Packages expiring in 30 days', value: n(live.expiring), type: 'number' as const, hint: `${live.active} active` },
        { key: 'members', label: 'Active members', value: planRows.reduce((t, r) => t + r.active, 0), type: 'number' as const },
        { key: 'memRevenue', label: 'Membership sales', value: round2(planRows.reduce((t, r) => t + r.revenue, 0)), type: 'money' as const },
      ],
      tables: [
        { key: 'packages', title: 'Packages', columns: [{ key: 'package', label: 'Package' }, { key: 'sold', label: 'Sold', type: 'number' as const }, { key: 'active', label: 'Still active', type: 'number' as const }, { key: 'revenue', label: 'Sales (ex tax)', type: 'money' as const }], rows: pkgRows },
        { key: 'plans', title: 'Membership plans', columns: [{ key: 'plan', label: 'Plan' }, { key: 'sold', label: 'Sold', type: 'number' as const }, { key: 'active', label: 'Active', type: 'number' as const }, { key: 'autoRenew', label: 'Auto-renew', type: 'number' as const }, { key: 'revenue', label: 'Sales (ex tax)', type: 'money' as const }], rows: planRows },
      ],
    };
  }

  // ---------- offers & discounts ----------

  private async offers(ctx: Ctx) {
    const offers = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT o.name, count(r.id)::int AS uses, coalesce(sum(r."discountAmount"),0) AS discount, coalesce(sum(i.total),0) AS sales
      FROM offer_redemptions r JOIN offers o ON o.id = r."offerId" JOIN invoices i ON i.id = r."invoiceId"
      WHERE r."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND r."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY o.id ORDER BY 3 DESC`;
    const coupons = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT c.code, count(r.id)::int AS uses, coalesce(sum(r."discountAmount"),0) AS discount, coalesce(sum(i.total),0) AS sales, count(DISTINCT r."customerId")::int AS customers
      FROM coupon_redemptions r JOIN coupons c ON c.id = r."couponId" JOIN invoices i ON i.id = r."invoiceId"
      WHERE r."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND r."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}
      GROUP BY c.id ORDER BY 3 DESC`;
    const [kinds] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum((it.meta->>'membershipDiscount')::numeric),0) AS membership,
             coalesce(sum((it.meta->>'manualDiscount')::numeric),0) AS manual,
             coalesce(sum((it.meta->>'coveredAmount')::numeric),0) AS covered
      FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}`;
    const offerTotal = offers.reduce((t, r) => t + n(r.discount), 0);
    const couponTotal = coupons.reduce((t, r) => t + n(r.discount), 0);
    return {
      metrics: [
        { key: 'offers', label: 'Offer discounts', value: round2(offerTotal), type: 'money' as const },
        { key: 'coupons', label: 'Coupon discounts', value: round2(couponTotal), type: 'money' as const },
        { key: 'membership', label: 'Member discounts', value: round2(n(kinds.membership)), type: 'money' as const },
        { key: 'manual', label: 'Manual discounts', value: round2(n(kinds.manual)), type: 'money' as const },
        { key: 'covered', label: 'Prepaid (package / included)', value: round2(n(kinds.covered)), type: 'money' as const },
      ],
      tables: [
        { key: 'offers', title: 'Offers', columns: [{ key: 'name', label: 'Offer' }, { key: 'uses', label: 'Bills', type: 'number' as const }, { key: 'discount', label: 'Discount given', type: 'money' as const }, { key: 'sales', label: 'Bill value', type: 'money' as const }], rows: offers.map((r) => ({ name: String(r.name), uses: n(r.uses), discount: round2(n(r.discount)), sales: round2(n(r.sales)) })) },
        { key: 'coupons', title: 'Coupons', columns: [{ key: 'code', label: 'Code' }, { key: 'uses', label: 'Uses', type: 'number' as const }, { key: 'customers', label: 'Customers', type: 'number' as const }, { key: 'discount', label: 'Discount given', type: 'money' as const }, { key: 'sales', label: 'Bill value', type: 'money' as const }], rows: coupons.map((r) => ({ code: String(r.code), uses: n(r.uses), customers: n(r.customers), discount: round2(n(r.discount)), sales: round2(n(r.sales)) })) },
      ],
    };
  }

  // ---------- inventory ----------

  private async inventory(ctx: Ctx) {
    const moves = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT t."productId" AS id,
             coalesce(sum(t.quantity) FILTER (WHERE t.type = 'PURCHASE'),0) AS purchased,
             coalesce(-sum(t.quantity) FILTER (WHERE t.type = 'SALE'),0) AS sold,
             coalesce(-sum(t.quantity) FILTER (WHERE t.type = 'CONSUMPTION'),0) AS consumed,
             coalesce(sum(t.quantity) FILTER (WHERE t.type IN ('ADJUSTMENT','DAMAGE','RETURN')),0) AS adjusted,
             coalesce(-sum(t.quantity * coalesce(t."unitCost",0)) FILTER (WHERE t.type = 'CONSUMPTION'),0) AS "consumedValue",
             coalesce(-sum(t.quantity * coalesce(t."unitCost",0)) FILTER (WHERE t.type = 'SALE'),0) AS "soldCost"
      FROM inventory_transactions t
      WHERE t."tenantId" = ${ctx.tenantId} AND t."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 't."branchId"')}
      GROUP BY 1`;
    const stock = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT s."productId" AS id, sum(s.quantity) AS qty, bool_or(s."reorderLevel" > 0 AND s.quantity <= s."reorderLevel") AS low
      FROM inventory_stock s WHERE s."tenantId" = ${ctx.tenantId} ${this.branch(ctx, 's."branchId"')} GROUP BY 1`;
    const [retail] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(it.total - it.tax),0) AS revenue FROM invoice_items it JOIN invoices i ON i.id = it."invoiceId"
      WHERE i."tenantId" = ${ctx.tenantId} AND ${LIVE_INVOICE} AND it."itemType" = 'PRODUCT' AND i."issuedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'i."branchId"')}`;
    const [purchases] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum("totalCost"),0) AS total, count(*)::int AS count FROM purchases p
      WHERE p."tenantId" = ${ctx.tenantId} AND p."purchasedAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'p."branchId"')}`;
    const products = await this.db.product.findMany({ select: { id: true, name: true, sku: true, unit: true, costPrice: true, status: true } });
    const m = new Map(moves.map((r) => [String(r.id), r]));
    const s = new Map(stock.map((r) => [String(r.id), r]));
    const rows = products
      .map((p) => {
        const x = m.get(p.id);
        const y = s.get(p.id);
        const qty = round2(n(y?.qty));
        return {
          product: p.name,
          sku: p.sku,
          unit: p.unit,
          purchased: round2(n(x?.purchased)),
          sold: round2(n(x?.sold)),
          consumed: round2(n(x?.consumed)),
          adjusted: round2(n(x?.adjusted)),
          onHand: qty,
          stockValue: round2(Math.max(0, qty) * num(p.costPrice)),
          consumedValue: round2(n(x?.consumedValue)),
          low: y?.low ? 'Yes' : '',
        };
      })
      .filter((r) => r.onHand || r.purchased || r.sold || r.consumed || r.adjusted)
      .sort((a, b) => b.stockValue - a.stockValue);
    return {
      metrics: [
        { key: 'value', label: 'Stock value (at cost)', value: round2(rows.reduce((t, r) => t + r.stockValue, 0)), type: 'money' as const },
        { key: 'purchases', label: 'Purchases', value: round2(n(purchases.total)), type: 'money' as const, hint: `${purchases.count} orders` },
        { key: 'consumed', label: 'Used in sessions (cost)', value: round2(rows.reduce((t, r) => t + r.consumedValue, 0)), type: 'money' as const },
        { key: 'retail', label: 'Retail sales (ex tax)', value: round2(n(retail.revenue)), type: 'money' as const },
        { key: 'margin', label: 'Retail margin', value: round2(n(retail.revenue) - moves.reduce((t, r) => t + n(r.soldCost), 0)), type: 'money' as const },
        { key: 'low', label: 'Low-stock products', value: rows.filter((r) => r.low).length, type: 'number' as const },
      ],
      tables: [
        {
          key: 'products',
          title: 'Stock movement',
          columns: [
            { key: 'product', label: 'Product' },
            { key: 'sku', label: 'SKU' },
            { key: 'unit', label: 'Unit' },
            { key: 'purchased', label: 'Purchased', type: 'number' as const },
            { key: 'sold', label: 'Sold', type: 'number' as const },
            { key: 'consumed', label: 'Consumed', type: 'number' as const },
            { key: 'adjusted', label: 'Adjusted', type: 'number' as const },
            { key: 'onHand', label: 'On hand', type: 'number' as const },
            { key: 'stockValue', label: 'Stock value', type: 'money' as const },
            { key: 'low', label: 'Low' },
          ],
          rows,
        },
      ],
    };
  }

  // ---------- expenses ----------

  private async expenses(ctx: Ctx) {
    const range = Prisma.sql`e."expenseDate" BETWEEN ${ctx.from}::date AND ${ctx.to}::date`;
    const byCat = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT e.category, count(*)::int AS count, sum(e.amount) AS amount FROM expenses e
      WHERE e."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'e."branchId"')} GROUP BY 1 ORDER BY 3 DESC`;
    const byBranch = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT b.name AS branch, count(*)::int AS count, sum(e.amount) AS amount FROM expenses e JOIN branches b ON b.id = e."branchId"
      WHERE e."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'e."branchId"')} GROUP BY 1 ORDER BY 3 DESC`;
    const series = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT to_char(date_trunc(${ctx.groupBy}, e."expenseDate"), 'YYYY-MM-DD') AS period, sum(e.amount) AS amount FROM expenses e
      WHERE e."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'e."branchId"')} GROUP BY 1`;
    const list = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT e."expenseDate" AS date, b.name AS branch, e.category, e.vendor, e.description, e."paymentMethod" AS method, e.amount
      FROM expenses e JOIN branches b ON b.id = e."branchId"
      WHERE e."tenantId" = ${ctx.tenantId} AND ${range} ${this.branch(ctx, 'e."branchId"')} ORDER BY e."expenseDate" DESC LIMIT 1000`;
    const total = byCat.reduce((t, r) => t + n(r.amount), 0);
    const points = this.fill(ctx, series, ['amount']);
    return {
      metrics: [
        { key: 'total', label: 'Total expenses', value: round2(total), type: 'money' as const, hint: `${byCat.reduce((t, r) => t + n(r.count), 0)} entries` },
        ...byCat.slice(0, 3).map((r) => ({ key: String(r.category), label: String(r.category).charAt(0) + String(r.category).slice(1).toLowerCase(), value: round2(n(r.amount)), type: 'money' as const, hint: `${pct(n(r.amount), total)}% of total` })),
      ],
      series: { title: 'Expenses', lines: [{ key: 'amount', label: 'Expenses', type: 'money' as const }], points },
      tables: [
        { key: 'categories', title: 'By category', columns: [{ key: 'category', label: 'Category' }, { key: 'count', label: 'Entries', type: 'number' as const }, { key: 'amount', label: 'Amount', type: 'money' as const }, { key: 'share', label: 'Share', type: 'percent' as const }], rows: byCat.map((r) => ({ category: String(r.category), count: n(r.count), amount: round2(n(r.amount)), share: pct(n(r.amount), total) })) },
        { key: 'branches', title: 'By branch', columns: [{ key: 'branch', label: 'Branch' }, { key: 'count', label: 'Entries', type: 'number' as const }, { key: 'amount', label: 'Amount', type: 'money' as const }], rows: byBranch.map((r) => ({ branch: String(r.branch), count: n(r.count), amount: round2(n(r.amount)) })) },
        {
          key: 'entries',
          title: 'Entries',
          columns: [{ key: 'date', label: 'Date', type: 'date' as const }, { key: 'branch', label: 'Branch' }, { key: 'category', label: 'Category' }, { key: 'vendor', label: 'Vendor' }, { key: 'description', label: 'Description' }, { key: 'method', label: 'Paid by' }, { key: 'amount', label: 'Amount', type: 'money' as const }],
          rows: list.map((r) => ({ date: (r.date as Date).toISOString().slice(0, 10), branch: String(r.branch), category: String(r.category), vendor: (r.vendor as string) ?? '', description: (r.description as string) ?? '', method: String(r.method), amount: round2(n(r.amount)) })),
        },
      ],
    };
  }

  // ---------- profit & loss ----------

  /**
   * P&L from the general ledger (accrual basis): income accounts net of discounts and returns,
   * less cost of goods and operating expenses. Therapist commission is accrued per session in
   * its own table rather than the ledger, so it is added here as a separate expense line.
   */
  private async pnl(ctx: Ctx) {
    const accounts = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT a.code, a.name, a.type, sum(e.credit - e.debit) AS balance
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e."accountId"
      WHERE e."tenantId" = ${ctx.tenantId} AND a.type IN ('INCOME','EXPENSE') AND e."entryDate" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'e."branchId"')}
      GROUP BY a.code, a.name, a.type ORDER BY a.code`;
    const series = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'e."entryDate"')} AS period,
             sum(CASE WHEN a.type = 'INCOME' THEN e.credit - e.debit ELSE 0 END) AS revenue,
             sum(CASE WHEN a.type = 'EXPENSE' THEN e.debit - e.credit ELSE 0 END) AS costs
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e."accountId"
      WHERE e."tenantId" = ${ctx.tenantId} AND a.type IN ('INCOME','EXPENSE') AND e."entryDate" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'e."branchId"')}
      GROUP BY 1`;
    const commissionSeries = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${this.bucket(ctx, 'c."createdAt"')} AS period, sum(c.amount) AS commission
      FROM therapist_commissions c WHERE c."tenantId" = ${ctx.tenantId} AND c."createdAt" BETWEEN ${ctx.start} AND ${ctx.end} ${this.branch(ctx, 'c."branchId"')}
      GROUP BY 1`;
    const income = accounts.filter((a) => a.type === 'INCOME');
    const expense = accounts.filter((a) => a.type === 'EXPENSE');
    const revenue = round2(income.reduce((t, a) => t + n(a.balance), 0));
    const cogs = round2(-n(expense.find((a) => a.code === '5100')?.balance));
    const opex = round2(-expense.filter((a) => a.code !== '5100').reduce((t, a) => t + n(a.balance), 0));
    const commission = round2(commissionSeries.reduce((t, r) => t + n(r.commission), 0));
    const gross = round2(revenue - cogs);
    const net = round2(gross - opex - commission);
    const c = new Map(commissionSeries.map((r) => [String(r.period), n(r.commission)]));
    const points = this.fill(
      ctx,
      series.map((r) => ({ ...r, costs: n(r.costs) + (c.get(String(r.period)) ?? 0) })),
      ['revenue', 'costs'],
    ).map((p) => ({ ...p, profit: round2(n(p.revenue) - n(p.costs)) }));
    const lines: ReportTable['rows'] = [
      ...income.map((a) => ({ section: 'Income', account: `${a.code} ${a.name}`, amount: round2(n(a.balance)) })),
      { section: 'Income', account: 'Total revenue', amount: revenue },
      { section: 'Cost of sales', account: '5100 Cost of goods sold', amount: -cogs },
      { section: 'Gross profit', account: 'Gross profit', amount: gross },
      ...expense.filter((a) => a.code !== '5100').map((a) => ({ section: 'Expenses', account: `${a.code} ${a.name}`, amount: round2(n(a.balance)) })),
      { section: 'Expenses', account: 'Therapist commission (accrued)', amount: -commission },
      { section: 'Net profit', account: 'Net profit', amount: net },
    ];
    return {
      metrics: [
        { key: 'revenue', label: 'Revenue', value: revenue, type: 'money' as const },
        { key: 'cogs', label: 'Cost of goods', value: cogs, type: 'money' as const },
        { key: 'gross', label: 'Gross profit', value: gross, type: 'money' as const, hint: `${pct(gross, revenue)}% margin` },
        { key: 'opex', label: 'Operating expenses', value: opex, type: 'money' as const },
        { key: 'commission', label: 'Commission', value: commission, type: 'money' as const },
        { key: 'net', label: 'Net profit', value: net, type: 'money' as const, hint: `${pct(net, revenue)}% of revenue` },
      ],
      series: { title: 'Revenue, costs and profit', lines: [{ key: 'revenue', label: 'Revenue', type: 'money' as const }, { key: 'costs', label: 'Costs', type: 'money' as const }, { key: 'profit', label: 'Profit', type: 'money' as const }], points },
      tables: [
        { key: 'statement', title: 'Statement', columns: [{ key: 'section', label: 'Section' }, { key: 'account', label: 'Account' }, { key: 'amount', label: 'Amount', type: 'money' as const }], rows: lines },
        { key: 'trend', title: 'By period', columns: [{ key: 'period', label: 'Period', type: 'date' as const }, { key: 'revenue', label: 'Revenue', type: 'money' as const }, { key: 'costs', label: 'Costs', type: 'money' as const }, { key: 'profit', label: 'Profit', type: 'money' as const }], rows: points },
      ],
    };
  }
}
