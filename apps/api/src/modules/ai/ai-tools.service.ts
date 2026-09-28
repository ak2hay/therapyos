import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { HqService } from '../hq/hq.module';
import { Period } from './ai-period';

export type AiIntent = 'revenue_change' | 'contact_customers' | 'service_trends' | 'repeat_visits' | 'peak_times' | 'branch_attention' | 'overview';

export interface AiContext {
  tenantId: string;
  tz: string;
  currency: string;
  /** Branches the answer covers: the caller's scope (or the requested branch), else every branch. */
  branchIds: string[];
  branchNames: Map<string, string>;
  scoped: boolean;
}

export interface AiResult {
  intent: AiIntent;
  title: string;
  headline: string;
  insights: string[];
  period?: { from: string; to: string; label: string; previousFrom: string; previousTo: string; previousLabel: string };
  metrics: Record<string, unknown>;
  table?: { columns: string[]; rows: (string | number | null)[][] };
  heatmap?: { days: string[]; hours: number[]; values: number[][] };
  actions?: { label: string; href: string }[];
}

const LIVE = Prisma.sql`i.status NOT IN ('CANCELLED','DRAFT')`;
const n = (v: unknown) => num(v as number);
const change = (cur: number, prev: number) => (prev ? round2(((cur - prev) / prev) * 100) : null);
const pctText = (v: number | null) => (v === null ? 'new' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => DateTime.fromObject({ hour: h }).toFormat('h a');

interface RevenueFacts {
  revenue: number;
  invoices: number;
  avgBill: number;
  customers: number;
  returning: number;
  newCustomers: number;
  sessions: number;
  appointments: number;
  cancelled: number;
  noShows: number;
  byBranch: Map<string, number>;
  byService: Map<string, { name: string; revenue: number; qty: number }>;
}

/**
 * Metric "tools" for the business assistant. Every number the assistant states comes from one of these
 * queries; the language model only phrases them. Raw SQL: tenant and branch filters are explicit.
 */
@Injectable()
export class AiToolsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly hq: HqService,
  ) {}

  private money(c: AiContext, v: number) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(v);
  }

  private period(p: Period): AiResult['period'] {
    return { from: p.start.toISODate()!, to: p.end.toISODate()!, label: p.label, previousFrom: p.prevStart.toISODate()!, previousTo: p.prevEnd.toISODate()!, previousLabel: p.prevLabel };
  }

  private async revenueFacts(c: AiContext, startDt: DateTime, endDt: DateTime): Promise<RevenueFacts> {
    const { tenantId, branchIds } = c;
    const [start, end] = [startDt.toJSDate(), endDt.toJSDate()];
    const scope = Prisma.sql`= ANY(${branchIds}::text[])`;
    const custScope = c.scoped ? Prisma.sql`AND c."primaryBranchId" ${scope}` : Prisma.empty;
    const [totals, branches, services, sessions, appts, fresh] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*)::int AS invoices, coalesce(sum(i.total - i.tax),0) AS revenue, count(DISTINCT i."customerId")::int AS customers,
               count(DISTINCT i."customerId") FILTER (WHERE EXISTS (
                 SELECT 1 FROM invoices j WHERE j."tenantId" = i."tenantId" AND j."customerId" = i."customerId" AND j.status NOT IN ('CANCELLED','DRAFT') AND j."issuedAt" < ${start}
               ))::int AS returning
        FROM invoices i WHERE i."tenantId" = ${tenantId} AND ${LIVE} AND i."issuedAt" BETWEEN ${start} AND ${end} AND i."branchId" ${scope}`,
      this.db.$queryRaw<{ id: string; revenue: unknown }[]>`
        SELECT i."branchId" AS id, sum(i.total - i.tax) AS revenue FROM invoices i
        WHERE i."tenantId" = ${tenantId} AND ${LIVE} AND i."issuedAt" BETWEEN ${start} AND ${end} AND i."branchId" ${scope} GROUP BY 1`,
      this.db.$queryRaw<{ id: string; name: string; revenue: unknown; qty: number }[]>`
        SELECT ii."itemId" AS id, max(ii.description) AS name, sum(ii.total - ii.tax) AS revenue, sum(ii.quantity)::int AS qty
        FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId"
        WHERE i."tenantId" = ${tenantId} AND ${LIVE} AND ii."itemType" = 'SERVICE' AND i."issuedAt" BETWEEN ${start} AND ${end} AND i."branchId" ${scope}
        GROUP BY 1`,
      this.db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM therapy_sessions s
        WHERE s."tenantId" = ${tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${start} AND ${end} AND s."branchId" ${scope}`,
      this.db.$queryRaw<Record<string, number>[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled, count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows
        FROM appointments a WHERE a."tenantId" = ${tenantId} AND a."startTime" BETWEEN ${start} AND ${end} AND a."branchId" ${scope}`,
      this.db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM customers c WHERE c."tenantId" = ${tenantId} AND c."createdAt" BETWEEN ${start} AND ${end} ${custScope}`,
    ]);
    const t = totals[0] ?? {};
    const revenue = round2(n(t.revenue));
    const invoices = n(t.invoices);
    return {
      revenue,
      invoices,
      avgBill: invoices ? round2(revenue / invoices) : 0,
      customers: n(t.customers),
      returning: n(t.returning),
      newCustomers: n(fresh[0]?.n),
      sessions: n(sessions[0]?.n),
      appointments: n(appts[0]?.total),
      cancelled: n(appts[0]?.cancelled),
      noShows: n(appts[0]?.no_shows),
      byBranch: new Map(branches.map((b) => [b.id, round2(n(b.revenue))])),
      byService: new Map(services.map((s) => [s.id, { name: s.name, revenue: round2(n(s.revenue)), qty: n(s.qty) }])),
    };
  }

  // ---------------------------------------------------------------- revenue

  async revenueChange(c: AiContext, p: Period, intent: AiIntent = 'revenue_change'): Promise<AiResult> {
    const [cur, prev] = await Promise.all([this.revenueFacts(c, p.start, p.end), this.revenueFacts(c, p.prevStart, p.prevEnd)]);
    const m = (v: number) => this.money(c, v);
    const delta = round2(cur.revenue - prev.revenue);
    const pct = change(cur.revenue, prev.revenue);
    const direction = Math.abs(pct ?? 100) < 2 ? 'held steady' : delta > 0 ? 'rose' : 'fell';
    const headline =
      direction === 'held steady'
        ? `Net sales held steady at ${m(cur.revenue)} for ${p.label} (${m(prev.revenue)} in ${p.prevLabel}).`
        : `Net sales ${direction} ${pct === null ? '' : `${Math.abs(pct).toFixed(1)}% `}to ${m(cur.revenue)} for ${p.label}, from ${m(prev.revenue)} in ${p.prevLabel} (${delta > 0 ? '+' : '−'}${m(Math.abs(delta))}).`;

    const insights: string[] = [];
    if (!cur.invoices && !prev.invoices) {
      return { intent, title: 'Revenue', headline: `There were no bills in ${p.label} or ${p.prevLabel}.`, insights: [], period: this.period(p), metrics: { current: cur, previous: prev } };
    }
    const billsPct = change(cur.invoices, prev.invoices);
    const avgPct = change(cur.avgBill, prev.avgBill);
    const volumeDriven = Math.abs(billsPct ?? 0) >= Math.abs(avgPct ?? 0);
    insights.push(
      `Bills went from ${prev.invoices} to ${cur.invoices} (${pctText(billsPct)}) and the average bill from ${m(prev.avgBill)} to ${m(cur.avgBill)} (${pctText(avgPct)}), so the change is driven mainly by ${volumeDriven ? 'the number of visits' : 'spend per visit'}.`,
    );
    insights.push(`Completed sessions: ${prev.sessions} → ${cur.sessions} (${pctText(change(cur.sessions, prev.sessions))}).`);
    const curNew = cur.customers - cur.returning;
    const prevNew = prev.customers - prev.returning;
    insights.push(`Paying customers: ${prev.customers} → ${cur.customers}; returning ${prev.returning} → ${cur.returning}, first-time ${prevNew} → ${curNew}. New customer sign-ups: ${prev.newCustomers} → ${cur.newCustomers}.`);
    const lostNow = cur.cancelled + cur.noShows;
    const lostBefore = prev.cancelled + prev.noShows;
    if (lostNow || lostBefore) {
      insights.push(`Cancellations ${prev.cancelled} → ${cur.cancelled} and no-shows ${prev.noShows} → ${cur.noShows} out of ${cur.appointments} appointments${lostNow > lostBefore ? ', so more booked visits were lost than before' : ''}.`);
    }
    const branchRows = c.branchIds
      .map((id) => ({ id, name: c.branchNames.get(id) ?? id, cur: cur.byBranch.get(id) ?? 0, prev: prev.byBranch.get(id) ?? 0 }))
      .map((b) => ({ ...b, delta: round2(b.cur - b.prev) }))
      .sort((a, b) => a.delta - b.delta);
    if (branchRows.length > 1) {
      const moved = direction === 'rose' ? [...branchRows].reverse()[0] : branchRows[0];
      if (moved && moved.delta) insights.push(`By branch, ${moved.name} moved most: ${moved.delta > 0 ? '+' : '−'}${m(Math.abs(moved.delta))} (${pctText(change(moved.cur, moved.prev))}).`);
    }
    const svc = [...new Set([...cur.byService.keys(), ...prev.byService.keys()])]
      .map((id) => ({ name: cur.byService.get(id)?.name ?? prev.byService.get(id)!.name, delta: round2((cur.byService.get(id)?.revenue ?? 0) - (prev.byService.get(id)?.revenue ?? 0)) }))
      .filter((s) => Math.abs(s.delta) >= 1)
      .sort((a, b) => a.delta - b.delta);
    const down = svc.filter((s) => s.delta < 0).slice(0, 3);
    const up = svc.filter((s) => s.delta > 0).reverse().slice(0, 3);
    if (down.length) insights.push(`Services with the biggest drop: ${down.map((s) => `${s.name} −${m(-s.delta)}`).join(', ')}.`);
    if (up.length) insights.push(`Services with the biggest gain: ${up.map((s) => `${s.name} +${m(s.delta)}`).join(', ')}.`);

    return {
      intent,
      title: intent === 'overview' ? 'Business snapshot' : 'Revenue change',
      headline,
      insights,
      period: this.period(p),
      metrics: {
        current: { ...cur, byBranch: Object.fromEntries(cur.byBranch), byService: undefined },
        previous: { ...prev, byBranch: Object.fromEntries(prev.byBranch), byService: undefined },
        revenueChangePct: pct,
        topServiceDrops: down,
        topServiceGains: up,
      },
      table: branchRows.length > 1 ? { columns: ['Branch', 'Net sales', 'Previous', 'Change'], rows: branchRows.map((b) => [b.name, b.cur, b.prev, pctText(change(b.cur, b.prev))]) } : undefined,
      actions: [{ label: 'Open sales report', href: `/reports?report=sales&from=${p.start.toISODate()}&to=${p.end.toISODate()}` }, ...(c.branchIds.length > 1 ? [{ label: 'Compare branches', href: '/hq' }] : [])],
    };
  }

  // ---------------------------------------------------------------- customers to contact

  async contactCustomers(c: AiContext): Promise<AiResult> {
    const { tenantId, branchIds } = c;
    const scope = c.scoped ? Prisma.sql`AND c."primaryBranchId" = ANY(${branchIds}::text[])` : Prisma.empty;
    const soon = DateTime.now().plus({ days: 14 }).toJSDate();
    const now = new Date();
    const [atRisk, atRiskTotals, overdue, packages, memberships] = await Promise.all([
      this.db.$queryRaw<{ id: string; name: string; last: Date | null; ltv: unknown; visits: number; segment: string }[]>`
        SELECT c.id, c.name, m."lastVisitAt" AS last, m."lifetimeValue" AS ltv, m."visitCount" AS visits, m.segment::text AS segment
        FROM customer_metrics m JOIN customers c ON c.id = m."customerId"
        WHERE m."tenantId" = ${tenantId} AND m.segment IN ('AT_RISK','INACTIVE') ${scope}
        ORDER BY m."lifetimeValue" DESC LIMIT 8`,
      this.db.$queryRaw<{ n: number; ltv: unknown }[]>`
        SELECT count(*)::int AS n, coalesce(sum(m."lifetimeValue"),0) AS ltv FROM customer_metrics m JOIN customers c ON c.id = m."customerId"
        WHERE m."tenantId" = ${tenantId} AND m.segment IN ('AT_RISK','INACTIVE') ${scope}`,
      this.db.$queryRaw<{ id: string; name: string; last: Date; interval: unknown; ltv: unknown }[]>`
        SELECT c.id, c.name, m."lastVisitAt" AS last, m."avgVisitIntervalDays" AS interval, m."lifetimeValue" AS ltv
        FROM customer_metrics m JOIN customers c ON c.id = m."customerId"
        WHERE m."tenantId" = ${tenantId} AND m.segment IN ('ACTIVE','LOYAL','VIP') AND m."avgVisitIntervalDays" > 0 AND m."lastVisitAt" IS NOT NULL
          AND EXTRACT(EPOCH FROM (${now}::timestamp - m."lastVisitAt")) / 86400 > m."avgVisitIntervalDays" * 1.5 ${scope}
        ORDER BY m."lifetimeValue" DESC LIMIT 5`,
      this.db.$queryRaw<{ id: string; name: string; package: string; expires: Date; remaining: number }[]>`
        SELECT c.id, c.name, p.name AS package, cp."expiresAt" AS expires, coalesce(sum(i."totalQuantity" - i."usedQuantity"),0)::int AS remaining
        FROM customer_packages cp JOIN customers c ON c.id = cp."customerId" JOIN packages p ON p.id = cp."packageId"
        LEFT JOIN customer_package_items i ON i."customerPackageId" = cp.id
        WHERE cp."tenantId" = ${tenantId} AND cp.status = 'ACTIVE' AND cp."expiresAt" BETWEEN ${now} AND ${soon} ${scope}
        GROUP BY c.id, c.name, p.name, cp."expiresAt" HAVING coalesce(sum(i."totalQuantity" - i."usedQuantity"),0) > 0
        ORDER BY cp."expiresAt" LIMIT 8`,
      this.db.$queryRaw<{ id: string; name: string; plan: string; expires: Date; auto: boolean }[]>`
        SELECT c.id, c.name, mp.name AS plan, cm."expiresAt" AS expires, cm."autoRenew" AS auto
        FROM customer_memberships cm JOIN customers c ON c.id = cm."customerId" JOIN membership_plans mp ON mp.id = cm."membershipPlanId"
        WHERE cm."tenantId" = ${tenantId} AND cm.status = 'ACTIVE' AND cm."expiresAt" BETWEEN ${now} AND ${soon} ${scope}
        ORDER BY cm."expiresAt" LIMIT 8`,
    ]);
    const m = (v: number) => this.money(c, v);
    const daysAgo = (d: Date | null) => (d ? Math.round((Date.now() - d.getTime()) / 86_400_000) : null);
    const insights: string[] = [];
    const riskCount = n(atRiskTotals[0]?.n);
    if (riskCount) {
      insights.push(
        `${riskCount} customers are at risk or inactive, with ${m(n(atRiskTotals[0]?.ltv))} in lifetime spend. Most valuable: ${atRisk
          .slice(0, 3)
          .map((r) => `${r.name} (${m(n(r.ltv))}, last visit ${daysAgo(r.last)} days ago)`)
          .join('; ')}.`,
      );
    }
    if (overdue.length) {
      insights.push(`${overdue.length} regulars are overdue for their usual visit: ${overdue.map((r) => `${r.name} (usually every ${Math.round(n(r.interval))} days, last came ${daysAgo(r.last)} days ago)`).join('; ')}.`);
    }
    if (packages.length) {
      const sessions = packages.reduce((s, r) => s + r.remaining, 0);
      insights.push(`${packages.length} packages expire in the next 14 days with ${sessions} unused sessions. Remind ${packages.slice(0, 3).map((r) => `${r.name} (${r.remaining} left on ${r.package})`).join(', ')}.`);
    }
    if (memberships.length) {
      const manual = memberships.filter((r) => !r.auto);
      insights.push(`${memberships.length} memberships end in the next 14 days${manual.length ? `, ${manual.length} without auto-renew` : ''}: ${memberships.slice(0, 3).map((r) => `${r.name} (${r.plan}, ${DateTime.fromJSDate(r.expires).toFormat('d LLL')})`).join(', ')}.`);
    }
    const total = riskCount + overdue.length + packages.length + memberships.length;
    const rows: (string | number | null)[][] = [
      ...packages.map((r) => [r.name, `Package ends ${DateTime.fromJSDate(r.expires).toFormat('d LLL')} (${r.remaining} sessions left)`, null]),
      ...memberships.map((r) => [r.name, `Membership ends ${DateTime.fromJSDate(r.expires).toFormat('d LLL')}`, null]),
      ...overdue.map((r) => [r.name, `Overdue regular (${daysAgo(r.last)} days since last visit)`, n(r.ltv)]),
      ...atRisk.map((r) => [r.name, `${r.segment === 'AT_RISK' ? 'At risk' : 'Inactive'} (${daysAgo(r.last) ?? '—'} days since last visit)`, n(r.ltv)]),
    ];
    return {
      intent: 'contact_customers',
      title: 'Customers to contact this week',
      headline: total ? `There are ${total} good reasons to reach out this week, starting with expiring packages and your most valuable lapsed customers.` : 'No customers need a follow-up right now: nobody is at risk and no packages or memberships expire in the next 14 days.',
      insights,
      metrics: { atRiskCount: riskCount, atRiskLifetimeValue: n(atRiskTotals[0]?.ltv), overdueRegulars: overdue.length, expiringPackages: packages.length, expiringMemberships: memberships.length },
      table: rows.length ? { columns: ['Customer', 'Why', 'Lifetime value'], rows: rows.slice(0, 15) } : undefined,
      actions: [{ label: 'Start a win-back campaign', href: '/marketing?tab=campaigns' }, { label: 'See at-risk customers', href: '/marketing?tab=segments' }],
    };
  }

  // ---------------------------------------------------------------- service trends

  async serviceTrends(c: AiContext, p: Period): Promise<AiResult> {
    const [cur, prev] = await Promise.all([this.revenueFacts(c, p.start, p.end), this.revenueFacts(c, p.prevStart, p.prevEnd)]);
    const m = (v: number) => this.money(c, v);
    const rows = [...new Set([...cur.byService.keys(), ...prev.byService.keys()])]
      .map((id) => {
        const a = cur.byService.get(id);
        const b = prev.byService.get(id);
        return { name: a?.name ?? b!.name, qty: a?.qty ?? 0, prevQty: b?.qty ?? 0, revenue: a?.revenue ?? 0, prevRevenue: b?.revenue ?? 0 };
      })
      .map((r) => ({ ...r, delta: round2(r.revenue - r.prevRevenue), pct: change(r.revenue, r.prevRevenue) }))
      .sort((a, b) => b.delta - a.delta);
    if (!rows.length) return { intent: 'service_trends', title: 'Service trends', headline: `No services were billed in ${p.label} or ${p.prevLabel}.`, insights: [], period: this.period(p), metrics: {} };
    const growing = rows.filter((r) => r.delta > 0 && r.prevRevenue > 0).slice(0, 3);
    const brandNew = rows.filter((r) => r.prevRevenue === 0 && r.revenue > 0);
    const declining = rows.filter((r) => r.delta < 0).reverse().slice(0, 3);
    const top = [...rows].sort((a, b) => b.revenue - a.revenue)[0];
    const insights: string[] = [];
    if (growing.length) insights.push(`Growing: ${growing.map((r) => `${r.name} ${pctText(r.pct)} (${r.prevQty} → ${r.qty} sold, +${m(r.delta)})`).join('; ')}.`);
    if (brandNew.length) insights.push(`Newly selling: ${brandNew.slice(0, 3).map((r) => `${r.name} (${r.qty} sold, ${m(r.revenue)})`).join('; ')}.`);
    if (declining.length) insights.push(`Declining: ${declining.map((r) => `${r.name} ${pctText(r.pct)} (${r.prevQty} → ${r.qty} sold, −${m(-r.delta)})`).join('; ')}.`);
    if (top && cur.revenue) insights.push(`${top.name} is the biggest earner at ${m(top.revenue)}, ${round2((top.revenue / Math.max(1, rows.reduce((s, r) => s + r.revenue, 0))) * 100)}% of service sales.`);
    return {
      intent: 'service_trends',
      title: 'Service trends',
      headline: growing.length ? `${growing[0].name} is your fastest-growing service over ${p.label} (${pctText(growing[0].pct)} vs ${p.prevLabel}).` : `No service grew over ${p.label} compared with ${p.prevLabel}.`,
      insights,
      period: this.period(p),
      metrics: { services: rows.slice(0, 20) },
      table: { columns: ['Service', 'Sold', 'Net sales', 'Previous', 'Change'], rows: rows.slice(0, 12).map((r) => [r.name, r.qty, r.revenue, r.prevRevenue, pctText(r.pct)]) },
      actions: [{ label: 'Service report', href: `/reports?report=services&from=${p.start.toISODate()}&to=${p.end.toISODate()}` }],
    };
  }

  // ---------------------------------------------------------------- repeat visits

  private async repeatByBranch(c: AiContext, startDt: DateTime, endDt: DateTime) {
    const [start, end] = [startDt.toJSDate(), endDt.toJSDate()];
    const rows = await this.db.$queryRaw<{ id: string; customers: number; returning: number }[]>`
      SELECT s."branchId" AS id, count(DISTINCT s."customerId")::int AS customers,
             count(DISTINCT s."customerId") FILTER (WHERE EXISTS (
               SELECT 1 FROM therapy_sessions t WHERE t."tenantId" = s."tenantId" AND t."customerId" = s."customerId" AND t.status = 'COMPLETED' AND t."completedAt" < ${start}
             ))::int AS returning
      FROM therapy_sessions s
      WHERE s."tenantId" = ${c.tenantId} AND s.status = 'COMPLETED' AND s."completedAt" BETWEEN ${start} AND ${end} AND s."branchId" = ANY(${c.branchIds}::text[])
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.id, r]));
  }

  async repeatVisits(c: AiContext, p: Period): Promise<AiResult> {
    const [cur, prev] = await Promise.all([this.repeatByBranch(c, p.start, p.end), this.repeatByBranch(c, p.prevStart, p.prevEnd)]);
    const rate = (r?: { customers: number; returning: number }) => (r?.customers ? round2((r.returning / r.customers) * 100) : null);
    const rows = c.branchIds
      .map((id) => {
        const now = rate(cur.get(id));
        const before = rate(prev.get(id));
        return { name: c.branchNames.get(id) ?? id, customers: cur.get(id)?.customers ?? 0, returning: cur.get(id)?.returning ?? 0, rate: now, prevRate: before, deltaPts: now !== null && before !== null ? round2(now - before) : null };
      })
      .sort((a, b) => (a.deltaPts ?? 0) - (b.deltaPts ?? 0));
    const sum = (m: Map<string, { customers: number; returning: number }>) => [...m.values()].reduce((s, r) => ({ customers: s.customers + r.customers, returning: s.returning + r.returning }), { customers: 0, returning: 0 });
    const overall = rate(sum(cur));
    const overallPrev = rate(sum(prev));
    const declining = rows.filter((r) => (r.deltaPts ?? 0) < -1);
    const insights: string[] = [];
    if (overall !== null) insights.push(`Across ${c.branchIds.length > 1 ? 'all branches in scope' : 'the branch'}, ${overall}% of customers served in ${p.label} were returning visitors, versus ${overallPrev ?? '—'}% in ${p.prevLabel}.`);
    for (const r of declining.slice(0, 3)) insights.push(`${r.name}: returning share fell from ${r.prevRate}% to ${r.rate}% (${r.deltaPts} pts); ${r.returning} of ${r.customers} customers had visited before.`);
    const improving = rows.filter((r) => (r.deltaPts ?? 0) > 1).reverse();
    if (improving.length) insights.push(`Improving: ${improving.map((r) => `${r.name} (${r.prevRate}% → ${r.rate}%)`).join(', ')}.`);
    return {
      intent: 'repeat_visits',
      title: 'Repeat visits by branch',
      headline: declining.length ? `${declining.map((r) => r.name).join(' and ')} ${declining.length > 1 ? 'have' : 'has'} fewer repeat visits in ${p.label} than in ${p.prevLabel}.` : `No branch has declining repeat visits in ${p.label} compared with ${p.prevLabel}.`,
      insights,
      period: this.period(p),
      metrics: { overall, overallPrevious: overallPrev, branches: rows },
      table: { columns: ['Branch', 'Customers', 'Returning', 'Previous', 'Change (pts)'], rows: rows.map((r) => [r.name, r.customers, r.rate === null ? '—' : `${r.rate}%`, r.prevRate === null ? '—' : `${r.prevRate}%`, r.deltaPts]) },
      actions: [{ label: 'Retention insights', href: '/marketing' }],
    };
  }

  // ---------------------------------------------------------------- peak times

  /** Earliest opening and latest closing hour across the branches, so heatmaps ignore out-of-hours noise. */
  async openHours(branchIds: string[]) {
    const rows = await this.db.branch.findMany({ where: { id: { in: branchIds } }, select: { openingTime: true, closingTime: true } });
    const hour = (t: string, up: boolean) => {
      const [h, m] = t.split(':').map(Number);
      return Math.min(24, Math.max(0, (h || 0) + (up && m > 0 ? 1 : 0)));
    };
    const from = rows.length ? Math.min(...rows.map((r) => hour(r.openingTime, false))) : 9;
    const to = rows.length ? Math.max(...rows.map((r) => hour(r.closingTime, true))) : 21;
    return to > from ? { from, to } : { from: 0, to: 24 };
  }

  async peakTimes(c: AiContext): Promise<AiResult> {
    const weeks = 8;
    const end = DateTime.now().setZone(c.tz);
    const start = end.minus({ weeks }).startOf('day');
    const [s, e] = [start.toJSDate(), end.toJSDate()];
    const [open, all] = await Promise.all([this.openHours(c.branchIds), this.db.$queryRaw<{ dow: number; hr: number; n: number }[]>`
      SELECT EXTRACT(ISODOW FROM (x.t AT TIME ZONE 'UTC') AT TIME ZONE ${c.tz})::int AS dow,
             EXTRACT(HOUR FROM (x.t AT TIME ZONE 'UTC') AT TIME ZONE ${c.tz})::int AS hr, count(*)::int AS n
      FROM (
        SELECT a."startTime" AS t FROM appointments a
        WHERE a."tenantId" = ${c.tenantId} AND a.status <> 'CANCELLED' AND a."startTime" BETWEEN ${s} AND ${e} AND a."branchId" = ANY(${c.branchIds}::text[])
        UNION ALL
        SELECT ts."startedAt" FROM therapy_sessions ts
        WHERE ts."tenantId" = ${c.tenantId} AND ts."appointmentId" IS NULL AND ts."startedAt" BETWEEN ${s} AND ${e} AND ts."branchId" = ANY(${c.branchIds}::text[])
      ) x GROUP BY 1, 2`]);
    const rows = all.filter((r) => r.hr >= open.from && r.hr < open.to);
    if (!rows.length) return { intent: 'peak_times', title: 'Demand by time slot', headline: 'There are no bookings or walk-ins during opening hours in the last 8 weeks to analyse.', insights: [], metrics: {} };
    const range = Array.from({ length: open.to - open.from }, (_, i) => open.from + i);
    const values = DAYS.map((_, d) => range.map((h) => round2((rows.find((r) => r.dow === d + 1 && r.hr === h)?.n ?? 0) / weeks)));
    const cells = DAYS.flatMap((day, d) => range.map((h, i) => ({ day, h, avg: values[d][i] })));
    const busiest = [...cells].sort((a, b) => b.avg - a.avg).slice(0, 3);
    const quiet = cells.filter((x) => !['Sat', 'Sun'].includes(x.day)).sort((a, b) => a.avg - b.avg || a.h - b.h).slice(0, 3);
    const byDay = DAYS.map((day, d) => ({ day, avg: round2(values[d].reduce((s2, v) => s2 + v, 0)) })).sort((a, b) => b.avg - a.avg);
    const slot = (x: { day: string; h: number }) => `${x.day} ${hourLabel(x.h)}–${hourLabel(x.h + 1)}`;
    const insights = [
      `Busiest slots over the last ${weeks} weeks: ${busiest.map((x) => `${slot(x)} (${x.avg} visits a week)`).join(', ')}.`,
      `Busiest day is ${byDay[0].day} with about ${byDay[0].avg} visits a week; quietest is ${byDay[byDay.length - 1].day} with ${byDay[byDay.length - 1].avg}.`,
      `Quietest weekday slots: ${quiet.map((x) => `${slot(x)} (${x.avg} a week)`).join(', ')}. These are good candidates for off-peak offers or staff breaks.`,
    ];
    return {
      intent: 'peak_times',
      title: 'Demand by time slot',
      headline: `Demand peaks on ${busiest[0].day} at ${hourLabel(busiest[0].h)}, averaging ${busiest[0].avg} visits in that hour each week.`,
      insights,
      period: { from: start.toISODate()!, to: end.toISODate()!, label: `the last ${weeks} weeks`, previousFrom: '', previousTo: '', previousLabel: '' },
      metrics: { weeks, busiest, quiet, byDay },
      heatmap: { days: DAYS, hours: range, values },
      actions: [{ label: 'Create an off-peak offer', href: '/offers' }],
    };
  }

  // ---------------------------------------------------------------- branch attention

  async branchAttention(c: AiContext, p: Period): Promise<AiResult> {
    const hq = await this.hq.overview({ from: p.start.toISODate()!, to: p.end.toISODate()! });
    const rows = hq.branches.filter((b) => c.branchIds.includes(b.branchId));
    const [lowStock, lowRatings] = await Promise.all([
      this.db.$queryRaw<{ id: string; n: number }[]>`
        SELECT s."branchId" AS id, count(*)::int AS n FROM inventory_stock s
        WHERE s."tenantId" = ${c.tenantId} AND s."reorderLevel" > 0 AND s.quantity <= s."reorderLevel" AND s."branchId" = ANY(${c.branchIds}::text[]) GROUP BY 1`,
      this.db.$queryRaw<{ id: string; n: number }[]>`
        SELECT f."branchId" AS id, count(*)::int AS n FROM feedback f
        WHERE f."tenantId" = ${c.tenantId} AND f.rating <= 2 AND f."createdAt" BETWEEN ${p.start.toJSDate()} AND ${p.end.toJSDate()} AND f."branchId" = ANY(${c.branchIds}::text[]) GROUP BY 1`,
    ]);
    const stock = new Map(lowStock.map((r) => [r.id, r.n]));
    const bad = new Map(lowRatings.map((r) => [r.id, r.n]));
    const avgNoShow = rows.length ? rows.reduce((s, r) => s + r.noShowRate, 0) / rows.length : 0;
    const m = (v: number) => this.money(c, v);
    const scored = rows
      .map((r) => {
        const issues: string[] = [];
        if (r.revenueGrowth <= -10) issues.push(`net sales down ${Math.abs(r.revenueGrowth)}% (${m(r.revenue)})`);
        if (r.noShowRate >= Math.max(8, avgNoShow * 1.5)) issues.push(`no-show rate ${r.noShowRate}%`);
        if (r.rating !== null && r.rating < 4) issues.push(`average rating ${r.rating}★`);
        if ((bad.get(r.branchId) ?? 0) >= 2) issues.push(`${bad.get(r.branchId)} ratings of 2★ or less`);
        if (r.utilization > 0 && r.utilization < 35) issues.push(`therapists only ${r.utilization}% utilised`);
        if ((stock.get(r.branchId) ?? 0) > 0) issues.push(`${stock.get(r.branchId)} products at or below reorder level`);
        return { name: r.name, issues, revenue: r.revenue, growth: r.revenueGrowth, noShowRate: r.noShowRate, rating: r.rating, utilization: r.utilization };
      })
      .sort((a, b) => b.issues.length - a.issues.length);
    const flagged = scored.filter((r) => r.issues.length);
    return {
      intent: 'branch_attention',
      title: 'Branches that need attention',
      headline: flagged.length ? `${flagged[0].name} needs the most attention right now (${flagged[0].issues.length} issue${flagged[0].issues.length > 1 ? 's' : ''} in ${p.label}).` : `Every branch is within normal ranges for ${p.label}.`,
      insights: flagged.map((r) => `${r.name}: ${r.issues.join('; ')}.`),
      period: this.period(p),
      metrics: { branches: scored, averageNoShowRate: round2(avgNoShow) },
      table: { columns: ['Branch', 'Net sales', 'vs prev.', 'No-show', 'Rating', 'Utilisation', 'Issues'], rows: scored.map((r) => [r.name, r.revenue, pctText(r.growth), `${r.noShowRate}%`, r.rating ?? '—', `${r.utilization}%`, r.issues.length]) },
      actions: [{ label: 'Open HQ dashboard', href: '/hq' }],
    };
  }
}
