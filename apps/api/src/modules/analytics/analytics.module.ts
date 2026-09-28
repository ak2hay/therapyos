import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { reportQuery, ReportQuery } from '@therapyos/validation';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { RequireFeature, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { num, round2 } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';

const LIVE = Prisma.sql`i.status NOT IN ('CANCELLED','DRAFT')`;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const COHORT_MONTHS = 6;
const n = (v: unknown) => num(v as number);
const pct = (part: number, whole: number) => (whole ? round2((part / whole) * 100) : 0);
const change = (cur: number, prev: number) => (prev ? round2(((cur - prev) / prev) * 100) : null);

interface Range {
  tenantId: string;
  tz: string;
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  days: number;
  from: DateTime;
  branch: (col: string) => Prisma.Sql;
}

/**
 * Advanced analytics: period-over-period KPIs, daily trend, first-visit cohorts, service mix, therapist
 * performance, acquisition channels, payment mix and demand heatmap. Raw SQL with explicit tenant and branch filters.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  private async range(q: ReportQuery): Promise<Range> {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const from = DateTime.fromISO(q.from, { zone: tz }).startOf('day');
    const to = DateTime.fromISO(q.to, { zone: tz }).endOf('day');
    if (!from.isValid || !to.isValid || to < from) throw AppError.validation('Choose a valid date range.');
    const days = Math.round(to.diff(from, 'days').days);
    if (days > 366) throw AppError.validation('Analytics cover at most one year at a time.');
    const prevEnd = from.minus({ milliseconds: 1 });
    const prevStart = from.minus({ days });
    const scope = RequestContext.branchScope(q.branchId);
    return {
      tenantId,
      tz,
      start: from.toJSDate(),
      end: to.toJSDate(),
      prevStart: prevStart.toJSDate(),
      prevEnd: prevEnd.toJSDate(),
      days,
      from,
      branch: (col) => (scope ? Prisma.sql`AND ${Prisma.raw(col)} = ANY(${scope}::text[])` : Prisma.empty),
    };
  }

  private async kpis(r: Range, start: Date, end: Date) {
    const [bills, sessions, appts, fresh] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*)::int AS invoices, coalesce(sum(i.total - i.tax),0) AS revenue, count(DISTINCT i."customerId")::int AS customers,
               count(DISTINCT i."customerId") FILTER (WHERE EXISTS (
                 SELECT 1 FROM invoices j WHERE j."tenantId" = i."tenantId" AND j."customerId" = i."customerId" AND j.status NOT IN ('CANCELLED','DRAFT') AND j."issuedAt" < ${start}
               ))::int AS returning
        FROM invoices i WHERE i."tenantId" = ${r.tenantId} AND ${LIVE} AND i."issuedAt" BETWEEN ${start} AND ${end} ${r.branch('i."branchId"')}`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*)::int AS n,
               avg(GREATEST(0, EXTRACT(EPOCH FROM (s."completedAt" - s."startedAt")) - s."totalPausedSeconds") / 60) FILTER (WHERE s."startedAt" IS NOT NULL) AS minutes
        FROM therapy_sessions s WHERE s."tenantId" = ${r.tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${start} AND ${end} ${r.branch('s."branchId"')}`,
      this.db.$queryRaw<Record<string, number>[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows, count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled
        FROM appointments a WHERE a."tenantId" = ${r.tenantId} AND a."startTime" BETWEEN ${start} AND ${end} ${r.branch('a."branchId"')}`,
      this.db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM customers c WHERE c."tenantId" = ${r.tenantId} AND c."createdAt" BETWEEN ${start} AND ${end} ${r.branch('c."primaryBranchId"')}`,
    ]);
    const b = bills[0] ?? {};
    const revenue = round2(n(b.revenue));
    const invoices = n(b.invoices);
    const customers = n(b.customers);
    const total = n(appts[0]?.total);
    return {
      revenue,
      invoices,
      avgBill: invoices ? round2(revenue / invoices) : 0,
      customers,
      returningRate: pct(n(b.returning), customers),
      newCustomers: n(fresh[0]?.n),
      sessions: n(sessions[0]?.n),
      avgSessionMinutes: round2(n(sessions[0]?.minutes)),
      appointments: total,
      noShowRate: pct(n(appts[0]?.no_shows), total),
      cancellationRate: pct(n(appts[0]?.cancelled), total),
    };
  }

  private async trend(r: Range) {
    const rows = await this.db.$queryRaw<{ d: Date; revenue: unknown; bills: number }[]>`
      SELECT date_trunc('day', (i."issuedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}) AS d, sum(i.total - i.tax) AS revenue, count(*)::int AS bills
      FROM invoices i WHERE i."tenantId" = ${r.tenantId} AND ${LIVE} AND i."issuedAt" BETWEEN ${r.prevStart} AND ${r.end} ${r.branch('i."branchId"')}
      GROUP BY 1`;
    const byDay = new Map(rows.map((x) => [DateTime.fromJSDate(x.d, { zone: 'UTC' }).toISODate(), round2(n(x.revenue))]));
    return Array.from({ length: r.days }, (_, i) => {
      const day = r.from.plus({ days: i });
      return { date: day.toISODate()!, revenue: byDay.get(day.toISODate()) ?? 0, previous: byDay.get(day.minus({ days: r.days }).toISODate()) ?? 0 };
    });
  }

  /** Customers grouped by the month of their first bill; each cell is the share who bought again k months later. */
  private async cohorts(r: Range) {
    const since = DateTime.now().setZone(r.tz).startOf('month').minus({ months: COHORT_MONTHS - 1 });
    const rows = await this.db.$queryRaw<{ cohort: Date; k: number; n: number }[]>`
      WITH activity AS (
        SELECT DISTINCT i."customerId" AS cid, date_trunc('month', (i."issuedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}) AS m
        FROM invoices i WHERE i."tenantId" = ${r.tenantId} AND ${LIVE} AND i."customerId" IS NOT NULL ${r.branch('i."branchId"')}
      ), firsts AS (SELECT cid, min(m) AS cohort FROM activity GROUP BY cid)
      SELECT f.cohort, ((EXTRACT(YEAR FROM a.m) - EXTRACT(YEAR FROM f.cohort)) * 12 + EXTRACT(MONTH FROM a.m) - EXTRACT(MONTH FROM f.cohort))::int AS k, count(*)::int AS n
      FROM firsts f JOIN activity a ON a.cid = f.cid
      WHERE f.cohort >= ${since.toFormat('yyyy-MM-dd')}::timestamp
      GROUP BY 1, 2`;
    return Array.from({ length: COHORT_MONTHS }, (_, i) => {
      const month = since.plus({ months: i });
      const key = month.toFormat('yyyy-MM');
      const cells = rows.filter((x) => DateTime.fromJSDate(x.cohort, { zone: 'UTC' }).toFormat('yyyy-MM') === key);
      const size = cells.find((x) => x.k === 0)?.n ?? 0;
      const available = COHORT_MONTHS - 1 - i;
      return {
        month: key,
        label: month.toFormat('LLL yyyy'),
        size,
        retention: Array.from({ length: available }, (_, k) => pct(cells.find((x) => x.k === k + 1)?.n ?? 0, size)),
      };
    });
  }

  private async services(r: Range) {
    const rows = await this.db.$queryRaw<{ id: string; name: string; revenue: unknown; qty: number; prev: unknown }[]>`
      SELECT ii."itemId" AS id, max(ii.description) AS name,
             coalesce(sum(ii.total - ii.tax) FILTER (WHERE i."issuedAt" >= ${r.start}),0) AS revenue,
             coalesce(sum(ii.quantity) FILTER (WHERE i."issuedAt" >= ${r.start}),0)::int AS qty,
             coalesce(sum(ii.total - ii.tax) FILTER (WHERE i."issuedAt" < ${r.start}),0) AS prev
      FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId"
      WHERE i."tenantId" = ${r.tenantId} AND ${LIVE} AND ii."itemType" = 'SERVICE' AND i."issuedAt" BETWEEN ${r.prevStart} AND ${r.end} ${r.branch('i."branchId"')}
      GROUP BY 1`;
    const total = rows.reduce((s, x) => s + n(x.revenue), 0);
    return rows
      .map((x) => ({ id: x.id, name: x.name, revenue: round2(n(x.revenue)), qty: n(x.qty), share: pct(n(x.revenue), total), change: change(n(x.revenue), n(x.prev)) }))
      .filter((x) => x.revenue > 0 || x.qty > 0)
      .sort((a, b) => b.revenue - a.revenue);
  }

  private async therapists(r: Range) {
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT t.id, t.name,
             (SELECT count(*)::int FROM therapy_sessions s WHERE s."therapistId" = t.id AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('s."branchId"')}) AS sessions,
             (SELECT avg(GREATEST(0, EXTRACT(EPOCH FROM (s."completedAt" - s."startedAt")) - s."totalPausedSeconds") / 60) FROM therapy_sessions s
               WHERE s."therapistId" = t.id AND s.status = 'COMPLETED' AND s."startedAt" IS NOT NULL AND s."completedAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('s."branchId"')}) AS minutes,
             (SELECT coalesce(sum(ii.total - ii.tax),0) FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId"
               WHERE ii."therapistId" = t.id AND ${LIVE} AND i."issuedAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('i."branchId"')}) AS revenue,
             (SELECT count(DISTINCT s."customerId")::int FROM therapy_sessions s WHERE s."therapistId" = t.id AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('s."branchId"')}) AS customers,
             (SELECT avg(f.rating) FROM feedback f WHERE f."therapistId" = t.id AND f."createdAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('f."branchId"')}) AS rating
      FROM therapists t WHERE t."tenantId" = ${r.tenantId} AND t.status = 'ACTIVE'`;
    return rows
      .map((x) => ({
        id: x.id as string,
        name: x.name as string,
        sessions: n(x.sessions),
        customers: n(x.customers),
        avgMinutes: round2(n(x.minutes)),
        revenue: round2(n(x.revenue)),
        rating: x.rating === null ? null : round2(n(x.rating)),
      }))
      .filter((x) => x.sessions || x.revenue)
      .sort((a, b) => b.revenue - a.revenue);
  }

  private async acquisition(r: Range) {
    const rows = await this.db.$queryRaw<{ source: string; customers: number; converted: number; revenue: unknown }[]>`
      SELECT c.source::text AS source, count(*)::int AS customers,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i."customerId" = c.id AND ${LIVE}))::int AS converted,
             coalesce(sum((SELECT sum(i.total - i.tax) FROM invoices i WHERE i."customerId" = c.id AND ${LIVE})),0) AS revenue
      FROM customers c WHERE c."tenantId" = ${r.tenantId} AND c."createdAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('c."primaryBranchId"')}
      GROUP BY 1 ORDER BY 2 DESC`;
    return rows.map((x) => ({ source: x.source, customers: x.customers, converted: x.converted, conversionRate: pct(x.converted, x.customers), revenue: round2(n(x.revenue)) }));
  }

  private async payments(r: Range) {
    const rows = await this.db.$queryRaw<{ method: string; amount: unknown; n: number }[]>`
      SELECT p.method::text AS method, sum(p.amount - p."refundedAmount") AS amount, count(*)::int AS n
      FROM payments p WHERE p."tenantId" = ${r.tenantId} AND p.status IN ('SUCCESS','PARTIALLY_REFUNDED') AND p."paidAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('p."branchId"')}
      GROUP BY 1 ORDER BY 2 DESC`;
    const total = rows.reduce((s, x) => s + n(x.amount), 0);
    return rows.map((x) => ({ method: x.method, amount: round2(n(x.amount)), count: x.n, share: pct(n(x.amount), total) }));
  }

  private async heatmap(r: Range) {
    const rows = await this.db.$queryRaw<{ dow: number; hr: number; n: number }[]>`
      SELECT EXTRACT(ISODOW FROM (x.t AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz})::int AS dow,
             EXTRACT(HOUR FROM (x.t AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz})::int AS hr, count(*)::int AS n
      FROM (
        SELECT a."startTime" AS t FROM appointments a
        WHERE a."tenantId" = ${r.tenantId} AND a.status <> 'CANCELLED' AND a."startTime" BETWEEN ${r.start} AND ${r.end} ${r.branch('a."branchId"')}
        UNION ALL
        SELECT ts."startedAt" FROM therapy_sessions ts
        WHERE ts."tenantId" = ${r.tenantId} AND ts."appointmentId" IS NULL AND ts."startedAt" BETWEEN ${r.start} AND ${r.end} ${r.branch('ts."branchId"')}
      ) x GROUP BY 1, 2`;
    const [open] = await this.db.$queryRaw<{ from: number | null; to: number | null }[]>`
      SELECT min(split_part(b."openingTime", ':', 1)::int) AS "from",
             max(ceil(split_part(b."closingTime", ':', 1)::int + split_part(b."closingTime", ':', 2)::int / 60.0))::int AS "to"
      FROM branches b WHERE b."tenantId" = ${r.tenantId} AND b.status = 'ACTIVE' ${r.branch('b.id')}`;
    const from = open?.from ?? 9;
    const to = open?.to && open.to > from ? Math.min(24, open.to) : 21;
    if (!rows.some((x) => x.hr >= from && x.hr < to)) return null;
    const hours = Array.from({ length: to - from }, (_, i) => from + i);
    return { days: DAYS, hours, values: DAYS.map((_, d) => hours.map((h) => rows.find((x) => x.dow === d + 1 && x.hr === h)?.n ?? 0)) };
  }

  async overview(q: ReportQuery) {
    const r = await this.range(q);
    const [current, previous, trend, cohorts, services, therapists, acquisition, payments, heatmap] = await Promise.all([
      this.kpis(r, r.start, r.end),
      this.kpis(r, r.prevStart, r.prevEnd),
      this.trend(r),
      this.cohorts(r),
      this.services(r),
      this.therapists(r),
      this.acquisition(r),
      this.payments(r),
      this.heatmap(r),
    ]);
    return {
      range: { from: q.from, to: q.to, previousFrom: DateTime.fromJSDate(r.prevStart, { zone: r.tz }).toISODate(), previousTo: DateTime.fromJSDate(r.prevEnd, { zone: r.tz }).toISODate(), days: r.days },
      current,
      previous,
      trend,
      cohorts,
      services,
      therapists,
      acquisition,
      payments,
      heatmap,
    };
  }
}

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
@RequireFeature(FeatureFlagKey.ADVANCED_ANALYTICS)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  overview(@Query(Zod(reportQuery)) q: ReportQuery) {
    return this.analytics.overview(q);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
