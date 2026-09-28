import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { hqQuery } from '@therapyos/validation';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { RequireFeature, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { num, round2 } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';

const PAID = Prisma.sql`('SUCCESS','PARTIALLY_REFUNDED','REFUNDED')`;
const LIVE_INVOICE = Prisma.sql`i.status NOT IN ('CANCELLED','DRAFT')`;
const n = (v: unknown) => num(v as number);
const pct = (a: number, b: number) => (b ? round2((a / b) * 100) : 0);
const growth = (cur: number, prev: number) => (prev ? round2(((cur - prev) / prev) * 100) : cur ? 100 : 0);

export interface BranchKpis {
  branchId: string;
  revenue: number;
  billed: number;
  collected: number;
  invoices: number;
  avgBill: number;
  appointments: number;
  noShows: number;
  noShowRate: number;
  cancelled: number;
  sessions: number;
  newCustomers: number;
  customers: number;
  rating: number | null;
  ratings: number;
  expenses: number;
  profit: number;
  margin: number;
  utilization: number;
}

@Injectable()
export class HqService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /** KPI rows per branch for [start, end]. Raw SQL: tenant and branch filters are explicit. */
  private async kpis(tenantId: string, branchIds: string[], start: Date, end: Date, days: number): Promise<Map<string, BranchKpis>> {
    const scope = Prisma.sql`= ANY(${branchIds}::text[])`;
    const [inv, pay, appt, sess, cust, fb, exp, therapists, branches, served] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT i."branchId" AS id, count(*)::int AS invoices, coalesce(sum(i.total),0) AS billed, coalesce(sum(i.total - i.tax),0) AS revenue
        FROM invoices i WHERE i."tenantId" = ${tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${start} AND ${end} AND i."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT p."branchId" AS id, coalesce(sum(p.amount - p."refundedAmount"),0) AS collected
        FROM payments p WHERE p."tenantId" = ${tenantId} AND p.status IN ${PAID} AND p."paidAt" BETWEEN ${start} AND ${end} AND p."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT a."branchId" AS id, count(*)::int AS total,
               count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows,
               count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled
        FROM appointments a WHERE a."tenantId" = ${tenantId} AND a."startTime" BETWEEN ${start} AND ${end} AND a."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT s."branchId" AS id, count(*)::int AS sessions,
               coalesce(sum(GREATEST(0, EXTRACT(EPOCH FROM (s."completedAt" - s."startedAt")) - s."totalPausedSeconds")),0) / 60 AS minutes
        FROM therapy_sessions s WHERE s."tenantId" = ${tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${start} AND ${end} AND s."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT c."primaryBranchId" AS id, count(*)::int AS new_customers
        FROM customers c WHERE c."tenantId" = ${tenantId} AND c."createdAt" BETWEEN ${start} AND ${end} AND c."primaryBranchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT f."branchId" AS id, avg(f.rating)::float AS rating, count(*)::int AS ratings
        FROM feedback f WHERE f."tenantId" = ${tenantId} AND f."createdAt" BETWEEN ${start} AND ${end} AND f."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT e."branchId" AS id, coalesce(sum(e.amount),0) AS expenses
        FROM expenses e WHERE e."tenantId" = ${tenantId} AND e."expenseDate" BETWEEN ${start}::date AND ${end}::date AND e."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT t."primaryBranchId" AS id, count(*)::int AS therapists
        FROM therapists t WHERE t."tenantId" = ${tenantId} AND t.status = 'ACTIVE' AND t."primaryBranchId" ${scope}
        GROUP BY 1`,
      this.db.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, openingTime: true, closingTime: true } }),
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT s."branchId" AS id, count(DISTINCT s."customerId")::int AS customers
        FROM therapy_sessions s WHERE s."tenantId" = ${tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${start} AND ${end} AND s."branchId" ${scope}
        GROUP BY 1`,
    ]);
    const idx = (rows: Record<string, unknown>[]) => new Map(rows.map((r) => [String(r.id), r]));
    const [I, P, A, S, C, F, E, T, V] = [inv, pay, appt, sess, cust, fb, exp, therapists, served].map(idx);
    const out = new Map<string, BranchKpis>();
    for (const b of branches) {
      const i = I.get(b.id);
      const a = A.get(b.id);
      const revenue = round2(n(i?.revenue));
      const expenses = round2(n(E.get(b.id)?.expenses));
      const invoices = n(i?.invoices);
      const appointments = n(a?.total);
      const noShows = n(a?.no_shows);
      const [oh, om] = b.openingTime.split(':').map(Number);
      const [ch, cm] = b.closingTime.split(':').map(Number);
      const capacity = n(T.get(b.id)?.therapists) * Math.max(0, ch * 60 + cm - (oh * 60 + om)) * days;
      out.set(b.id, {
        branchId: b.id,
        revenue,
        billed: round2(n(i?.billed)),
        collected: round2(n(P.get(b.id)?.collected)),
        invoices,
        avgBill: invoices ? round2(n(i?.billed) / invoices) : 0,
        appointments,
        noShows,
        noShowRate: pct(noShows, appointments),
        cancelled: n(a?.cancelled),
        sessions: n(S.get(b.id)?.sessions),
        newCustomers: n(C.get(b.id)?.new_customers),
        customers: n(V.get(b.id)?.customers),
        rating: F.get(b.id)?.rating == null ? null : round2(n(F.get(b.id)!.rating)),
        ratings: n(F.get(b.id)?.ratings),
        expenses,
        profit: round2(revenue - expenses),
        margin: pct(revenue - expenses, revenue),
        utilization: capacity ? Math.min(100, pct(n(S.get(b.id)?.minutes), capacity)) : 0,
      });
    }
    return out;
  }

  async overview(q: z.infer<typeof hqQuery>) {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const from = DateTime.fromISO(q.from, { zone: tz }).startOf('day');
    const to = DateTime.fromISO(q.to, { zone: tz }).endOf('day');
    if (!from.isValid || !to.isValid || to < from) throw AppError.validation('Choose a valid date range.');
    const days = Math.max(1, Math.round(to.diff(from, 'days').days));
    if (days > 366) throw AppError.validation('The HQ view covers at most one year at a time.');
    const prevTo = from.minus({ milliseconds: 1 });
    const prevFrom = prevTo.minus({ days: days - 1 }).startOf('day');

    const scope = RequestContext.branchScope();
    const branches = await this.db.branch.findMany({
      where: { ...(scope ? { id: { in: scope } } : {}), status: 'ACTIVE' },
      select: { id: true, name: true, code: true, city: true, franchiseBranch: { select: { franchisee: { select: { id: true, name: true } } } } },
      orderBy: { name: 'asc' },
    });
    const ids = branches.map((b) => b.id);
    if (!ids.length) return { from: q.from, to: q.to, previous: { from: prevFrom.toISODate(), to: prevTo.toISODate() }, totals: null, branches: [], trend: [] };

    const [cur, prev] = await Promise.all([
      this.kpis(tenantId, ids, from.toJSDate(), to.toJSDate(), days),
      this.kpis(tenantId, ids, prevFrom.toJSDate(), prevTo.toJSDate(), days),
    ]);

    const trendRows = await this.db.$queryRaw<{ day: string; id: string; revenue: unknown }[]>`
      SELECT to_char(date_trunc('day', i."issuedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, i."branchId" AS id, sum(i.total - i.tax) AS revenue
      FROM invoices i WHERE i."tenantId" = ${tenantId} AND ${LIVE_INVOICE} AND i."issuedAt" BETWEEN ${from.toJSDate()} AND ${to.toJSDate()} AND i."branchId" = ANY(${ids}::text[])
      GROUP BY 1, 2`;
    const trendMap = new Map<string, Record<string, number | string>>();
    for (let d = from; d <= to && trendMap.size < 400; d = d.plus({ days: 1 })) trendMap.set(d.toISODate()!, { day: d.toISODate()! });
    for (const r of trendRows) {
      const row = trendMap.get(r.day);
      if (row) row[r.id] = round2(n(r.revenue));
    }

    const rows = branches.map((b) => {
      const c = cur.get(b.id)!;
      const p = prev.get(b.id)!;
      return {
        ...c,
        name: b.name,
        code: b.code,
        city: b.city,
        franchisee: b.franchiseBranch?.franchisee ?? null,
        revenueGrowth: growth(c.revenue, p.revenue),
        previousRevenue: p.revenue,
      };
    });
    const sum = (m: Map<string, BranchKpis>, k: keyof BranchKpis) => round2([...m.values()].reduce((s, r) => s + n(r[k]), 0));
    const totalsFor = (m: Map<string, BranchKpis>) => {
      const revenue = sum(m, 'revenue');
      const invoices = sum(m, 'invoices');
      const appointments = sum(m, 'appointments');
      const rated = [...m.values()].filter((r) => r.ratings);
      const ratings = rated.reduce((s, r) => s + r.ratings, 0);
      return {
        revenue,
        billed: sum(m, 'billed'),
        collected: sum(m, 'collected'),
        invoices,
        avgBill: invoices ? round2(sum(m, 'billed') / invoices) : 0,
        appointments,
        noShowRate: pct(sum(m, 'noShows'), appointments),
        sessions: sum(m, 'sessions'),
        newCustomers: sum(m, 'newCustomers'),
        expenses: sum(m, 'expenses'),
        profit: round2(revenue - sum(m, 'expenses')),
        rating: ratings ? round2(rated.reduce((s, r) => s + (r.rating ?? 0) * r.ratings, 0) / ratings) : null,
      };
    };
    const totals = totalsFor(cur);
    const previousTotals = totalsFor(prev);
    return {
      from: q.from,
      to: q.to,
      previous: { from: prevFrom.toISODate(), to: prevTo.toISODate() },
      totals: {
        ...totals,
        revenueGrowth: growth(totals.revenue, previousTotals.revenue),
        sessionsGrowth: growth(totals.sessions, previousTotals.sessions),
        newCustomersGrowth: growth(totals.newCustomers, previousTotals.newCustomers),
        profitGrowth: growth(totals.profit, previousTotals.profit),
      },
      branches: rows,
      trend: [...trendMap.values()],
    };
  }
}

@ApiTags('HQ')
@ApiBearerAuth()
@Controller('hq')
export class HqController {
  constructor(private readonly hq: HqService) {}

  @Get('overview')
  @RequireFeature(FeatureFlagKey.MULTI_BRANCH)
  @RequirePermissions(PERMISSIONS.HQ_DASHBOARD)
  overview(@Query(Zod(hqQuery)) q: z.infer<typeof hqQuery>) {
    return this.hq.overview(q);
  }
}

@Module({ controllers: [HqController], providers: [HqService], exports: [HqService] })
export class HqModule {}
