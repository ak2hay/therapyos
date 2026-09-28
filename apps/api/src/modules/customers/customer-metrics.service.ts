import { Injectable } from '@nestjs/common';
import { CustomerSegment } from '@prisma/client';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { round2 } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';
import { OnDomainEvent } from '../../jobs/event-handlers';

const DAY = 86_400_000;

/**
 * Keeps `customer_metrics` in sync. Every recompute derives the row from source tables, so the
 * handler is naturally idempotent and safe to re-run (e.g. nightly for segment drift).
 */
@Injectable()
export class CustomerMetricsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  @OnDomainEvent('session.completed', 'invoice.paid', 'payment.refunded', 'package.purchased', 'membership.purchased', 'appointment.no_show')
  async onActivity(payload: Record<string, any>) {
    if (payload.customerId) await this.recompute(payload.customerId);
  }

  async recompute(customerId: string) {
    const tenantId = RequestContext.requireTenantId();
    const customer = await this.db.customer.findFirst({ where: { id: customerId }, select: { id: true } });
    if (!customer) return null;
    const now = new Date();
    const [visits, invoices, noShows, activePackages, activeMemberships, settings] = await Promise.all([
      this.db.therapySession.findMany({ where: { customerId, status: 'COMPLETED' }, select: { completedAt: true }, orderBy: { completedAt: 'asc' } }),
      this.db.invoice.findMany({ where: { customerId, status: { in: ['PAID', 'PARTIALLY_PAID', 'REFUNDED'] } }, select: { amountPaid: true, amountRefunded: true } }),
      this.db.appointment.count({ where: { customerId, status: 'NO_SHOW' } }),
      this.db.customerPackage.count({ where: { customerId, status: 'ACTIVE', expiresAt: { gt: now } } }),
      this.db.customerMembership.count({ where: { customerId, status: 'ACTIVE', expiresAt: { gte: now } } }),
      this.settings.getAll(tenantId),
    ]);
    const dates = visits.map((v) => v.completedAt!).filter(Boolean);
    const visitCount = dates.length;
    const firstVisitAt = dates[0] ?? null;
    const lastVisitAt = dates[visitCount - 1] ?? null;
    const avgInterval = visitCount > 1 ? (lastVisitAt!.getTime() - firstVisitAt!.getTime()) / DAY / (visitCount - 1) : null;
    const totalSpend = round2(invoices.reduce((s, i) => s + Number(i.amountPaid) - Number(i.amountRefunded), 0));
    const paidInvoices = invoices.filter((i) => Number(i.amountPaid) > 0).length;
    const avgSpend = paidInvoices ? round2(totalSpend / paidInvoices) : 0;
    // Expected LTV: average ticket × projected visits over the next two years at the observed cadence.
    const visitsPerYear = avgInterval && avgInterval > 0 ? Math.min(365 / avgInterval, 52) : visitCount ? 2 : 0;
    const expectedLtv = round2(totalSpend + avgSpend * visitsPerYear * 2);

    const segment = this.segment({
      visitCount,
      lastVisitAt,
      avgInterval,
      ltv: totalSpend,
      vipThreshold: Number(settings.VIP_LTV_THRESHOLD ?? 20000),
      inactiveAfter: Number(settings.INACTIVE_AFTER_DAYS ?? 60),
      churnedAfter: Number(settings.CHURNED_AFTER_DAYS ?? 120),
    });
    const data = {
      firstVisitAt,
      lastVisitAt,
      visitCount,
      avgVisitIntervalDays: avgInterval === null ? null : round2(avgInterval),
      totalSpend,
      avgSpend,
      lifetimeValue: totalSpend,
      expectedLtv,
      noShowCount: noShows,
      hasActivePackage: activePackages > 0,
      hasActiveMembership: activeMemberships > 0,
      segment,
    };
    return this.db.customerMetrics.upsert({ where: { customerId }, create: { customerId, tenantId, ...data }, update: data });
  }

  segment(p: { visitCount: number; lastVisitAt: Date | null; avgInterval: number | null; ltv: number; vipThreshold: number; inactiveAfter: number; churnedAfter: number }): CustomerSegment {
    if (!p.lastVisitAt) return 'NEW';
    const since = (Date.now() - p.lastVisitAt.getTime()) / DAY;
    if (since >= p.churnedAfter) return 'CHURNED';
    if (since >= p.inactiveAfter) return 'INACTIVE';
    if (p.ltv >= p.vipThreshold) return 'VIP';
    const expectedGap = p.avgInterval ? Math.max(p.avgInterval * 2, 30) : 45;
    if (p.visitCount > 1 && since > expectedGap) return 'AT_RISK';
    if (p.visitCount >= 5) return 'LOYAL';
    if (p.visitCount >= 2) return 'ACTIVE';
    return 'NEW';
  }
}
