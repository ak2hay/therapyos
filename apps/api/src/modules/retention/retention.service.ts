import { Injectable } from '@nestjs/common';
import { CustomerSegment, Prisma } from '@prisma/client';
import { CUSTOMER_SEGMENTS, PERMISSIONS } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { CustomerMetricsService } from '../customers/customer-metrics.service';
import { maskContact } from '../customers/customers.service';

const DAY = 86_400_000;
const LAPSED: CustomerSegment[] = ['INACTIVE', 'CHURNED'];

@Injectable()
export class RetentionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly metrics: CustomerMetricsService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
  ) {}

  /** Customers are attributed to their primary branch for branch-scoped retention views. */
  private customerScope(branchId?: string): Prisma.CustomerWhereInput {
    const scope = RequestContext.branchScope(branchId);
    return scope ? { primaryBranchId: { in: scope } } : {};
  }

  async overview(branchId?: string) {
    const tenantId = RequestContext.requireTenantId();
    const scope = RequestContext.branchScope(branchId);
    const customerWhere = this.customerScope(branchId);
    const metricsWhere: Prisma.CustomerMetricsWhereInput = { customer: customerWhere };
    const [bySegment, totals, visited, repeat, totalCustomers, atRisk, tz] = await Promise.all([
      this.db.customerMetrics.groupBy({ by: ['segment'], where: metricsWhere, _count: { _all: true }, _sum: { lifetimeValue: true }, _avg: { lifetimeValue: true } }),
      this.db.customerMetrics.aggregate({ where: { ...metricsWhere, visitCount: { gt: 0 } }, _avg: { lifetimeValue: true, expectedLtv: true, avgVisitIntervalDays: true, visitCount: true }, _sum: { lifetimeValue: true } }),
      this.db.customerMetrics.count({ where: { ...metricsWhere, visitCount: { gt: 0 } } }),
      this.db.customerMetrics.count({ where: { ...metricsWhere, visitCount: { gte: 2 } } }),
      this.db.customer.count({ where: customerWhere }),
      this.db.customerMetrics.findMany({
        where: { ...metricsWhere, segment: { in: ['AT_RISK', 'INACTIVE'] } },
        orderBy: { lifetimeValue: 'desc' },
        take: 10,
        include: { customer: { select: { id: true, name: true, phone: true, email: true, marketingOptIn: true } } },
      }),
      this.settings.timezone(tenantId),
    ]);

    const segments = CUSTOMER_SEGMENTS.map((s) => {
      const row = bySegment.find((b) => b.segment === s);
      return { segment: s, count: row?._count._all ?? 0, lifetimeValue: num(row?._sum.lifetimeValue), avgLifetimeValue: round2(num(row?._avg.lifetimeValue)) };
    });
    const lapsed = segments.filter((s) => LAPSED.includes(s.segment as CustomerSegment)).reduce((a, s) => a + s.count, 0);
    const atRiskValue = segments.filter((s) => s.segment === 'AT_RISK' || s.segment === 'INACTIVE').reduce((a, s) => a + s.lifetimeValue, 0);

    const branchFilter = scope ? Prisma.sql`AND s."branchId" = ANY(${scope}::text[])` : Prisma.empty;
    const cohortRows = await this.db.$queryRaw<{ cohort: string; offset: number; active: number }[]>`
      WITH visits AS (
        SELECT s."customerId", date_trunc('month', s."completedAt" AT TIME ZONE ${tz}) AS m
        FROM therapy_sessions s
        WHERE s."tenantId" = ${tenantId} AND s.status = 'COMPLETED' AND s."completedAt" IS NOT NULL ${branchFilter}
      ), firsts AS (
        SELECT "customerId", min(m) AS cohort FROM visits GROUP BY "customerId"
      )
      SELECT to_char(f.cohort, 'YYYY-MM') AS cohort,
             ((extract(year FROM v.m) - extract(year FROM f.cohort)) * 12 + extract(month FROM v.m) - extract(month FROM f.cohort))::int AS "offset",
             count(DISTINCT v."customerId")::int AS active
      FROM firsts f JOIN visits v ON v."customerId" = f."customerId"
      WHERE f.cohort >= date_trunc('month', now() AT TIME ZONE ${tz}) - interval '5 months'
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const cohortMap = new Map<string, { cohort: string; size: number; retention: number[] }>();
    for (const r of cohortRows) {
      const c = cohortMap.get(r.cohort) ?? { cohort: r.cohort, size: 0, retention: [] };
      if (r.offset === 0) c.size = r.active;
      cohortMap.set(r.cohort, c);
    }
    for (const r of cohortRows) {
      const c = cohortMap.get(r.cohort)!;
      if (r.offset > 0 && c.size) c.retention[r.offset - 1] = round2((r.active / c.size) * 100);
    }
    const cohorts = [...cohortMap.values()].map((c) => {
      const months = Math.max(0, ...cohortRows.filter((r) => r.cohort === c.cohort).map((r) => r.offset));
      return { ...c, retention: Array.from({ length: months }, (_, i) => c.retention[i] ?? 0) };
    });

    const canSeeContact = RequestContext.hasPermission(PERMISSIONS.CUSTOMER_CONTACT_VIEW);
    return {
      totals: {
        customers: totalCustomers,
        visited,
        repeatRate: visited ? round2((repeat / visited) * 100) : 0,
        churnRate: visited ? round2((lapsed / visited) * 100) : 0,
        avgLifetimeValue: round2(num(totals._avg.lifetimeValue)),
        avgExpectedLtv: round2(num(totals._avg.expectedLtv)),
        totalLifetimeValue: num(totals._sum.lifetimeValue),
        avgVisitIntervalDays: totals._avg.avgVisitIntervalDays === null ? null : round2(num(totals._avg.avgVisitIntervalDays)),
        avgVisits: round2(num(totals._avg.visitCount)),
        atRiskValue: round2(atRiskValue),
      },
      segments,
      cohorts,
      atRisk: atRisk.map((m) => ({
        customer: canSeeContact ? m.customer : maskContact(m.customer),
        segment: m.segment,
        lifetimeValue: num(m.lifetimeValue),
        visitCount: m.visitCount,
        lastVisitAt: m.lastVisitAt,
        daysSinceVisit: m.lastVisitAt ? Math.floor((Date.now() - m.lastVisitAt.getTime()) / DAY) : null,
      })),
    };
  }

  async customers(q: { page: number; pageSize: number; segment?: string; branchId?: string; search?: string; sort?: string; order: 'asc' | 'desc' }) {
    const where: Prisma.CustomerMetricsWhereInput = { customer: this.customerScope(q.branchId) };
    if (q.segment) where.segment = q.segment as CustomerSegment;
    if (q.search) where.customer = { ...(where.customer as object), OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] };
    const sortable = new Set(['lifetimeValue', 'lastVisitAt', 'visitCount', 'expectedLtv', 'totalSpend']);
    const sort = q.sort && sortable.has(q.sort) ? q.sort : 'lifetimeValue';
    const [items, total] = await Promise.all([
      this.db.customerMetrics.findMany({
        where,
        orderBy: sort === 'lastVisitAt' ? { lastVisitAt: { sort: q.order, nulls: 'last' } } : { [sort]: q.order },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true, marketingOptIn: true, primaryBranchId: true } } },
      }),
      this.db.customerMetrics.count({ where }),
    ]);
    const canSeeContact = RequestContext.hasPermission(PERMISSIONS.CUSTOMER_CONTACT_VIEW);
    return paged(
      items.map((m) => ({
        ...m,
        customer: canSeeContact ? m.customer : maskContact(m.customer),
        daysSinceVisit: m.lastVisitAt ? Math.floor((Date.now() - m.lastVisitAt.getTime()) / DAY) : null,
      })),
      total,
      q,
    );
  }

  /**
   * Recomputes every customer's metrics (segments drift with time even without activity) and
   * publishes `customer.inactive` for customers who just lapsed, which drives win-back messages.
   */
  async recomputeAll() {
    const before = await this.db.customerMetrics.findMany({ select: { customerId: true, segment: true } });
    const prev = new Map(before.map((b) => [b.customerId, b.segment]));
    const customers = await this.db.customer.findMany({ select: { id: true, primaryBranchId: true } });
    const transitions: Record<string, number> = {};
    let lapsed = 0;
    for (const c of customers) {
      const m = await this.metrics.recompute(c.id);
      if (!m) continue;
      const old = prev.get(c.id);
      if (old && old !== m.segment) transitions[`${old}->${m.segment}`] = (transitions[`${old}->${m.segment}`] ?? 0) + 1;
      if (m.segment === 'INACTIVE' && old && !LAPSED.includes(old)) {
        lapsed++;
        await this.events.publish(DomainEvents.CUSTOMER_INACTIVE, {
          customerId: c.id,
          branchId: c.primaryBranchId,
          lastVisitAt: m.lastVisitAt?.toISOString() ?? null,
          daysSinceVisit: m.lastVisitAt ? Math.floor((Date.now() - m.lastVisitAt.getTime()) / DAY) : null,
        });
      }
    }
    return { customers: customers.length, transitions, lapsed };
  }
}
