import { Injectable } from '@nestjs/common';
import { FeedbackSource, Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { env } from '../../config/env';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';

export interface FeedbackQuery {
  page: number;
  pageSize: number;
  branchId?: string;
  therapistId?: string;
  source?: string;
  rating?: number;
  maxRating?: number;
  from?: string;
  to?: string;
  search?: string;
}

interface CreateFeedback {
  tenantId: string;
  branchId: string;
  rating: number;
  comment?: string | null;
  source: FeedbackSource;
  customerId?: string | null;
  sessionId?: string | null;
  therapistId?: string | null;
}

@Injectable()
export class FeedbackService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  private async branding(tenantId: string) {
    const [tenant, brand] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, logoUrl: true, slug: true } }),
      this.db.tenantBranding.findUnique({ where: { tenantId } }),
    ]);
    return {
      businessName: brand?.appName || tenant?.name || '',
      logoUrl: brand?.logoUrl ?? tenant?.logoUrl ?? null,
      primaryColor: brand?.primaryColor ?? null,
      slug: tenant?.slug ?? '',
    };
  }

  /** One feedback per session (unique sessionId); retries or double-clicks return the first one. */
  private async record(input: CreateFeedback) {
    try {
      return await this.db.$transaction(async (tx) => {
        const fb = await tx.feedback.create({
          data: {
            tenantId: input.tenantId,
            branchId: input.branchId,
            customerId: input.customerId ?? null,
            sessionId: input.sessionId ?? null,
            therapistId: input.therapistId ?? null,
            rating: input.rating,
            comment: input.comment ?? null,
            source: input.source,
          },
        });
        if (input.customerId) {
          await this.activity.record({ customerId: input.customerId, branchId: input.branchId, type: 'FEEDBACK', title: `Rated ${input.rating}★`, refType: 'Feedback', refId: fb.id, meta: { comment: input.comment ?? null } }, tx);
        }
        await this.events.publish(
          DomainEvents.FEEDBACK_RECEIVED,
          { feedbackId: fb.id, rating: fb.rating, comment: fb.comment, branchId: fb.branchId, customerId: fb.customerId, therapistId: fb.therapistId, source: fb.source },
          tx,
        );
        return fb;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('Feedback for this visit has already been recorded.');
      throw e;
    }
  }

  // ---- Public: per-visit token link ----

  /** Token lookup happens before any tenant is known, so it runs unscoped and then binds the tenant. */
  private async loadRequest(token: string) {
    const req = await this.db.feedbackRequest.findUnique({ where: { token } });
    if (!req) throw AppError.notFound('Feedback link');
    RequestContext.bindTenant(req.tenantId);
    return req;
  }

  async tokenInfo(token: string) {
    const req = await this.loadRequest(token);
    const [brand, branch, session, customer] = await Promise.all([
      this.branding(req.tenantId),
      this.db.branch.findFirst({ where: { id: req.branchId }, select: { name: true } }),
      req.sessionId ? this.db.therapySession.findFirst({ where: { id: req.sessionId }, select: { service: { select: { name: true } }, therapist: { select: { name: true } }, completedAt: true } }) : null,
      req.customerId ? this.db.customer.findFirst({ where: { id: req.customerId }, select: { name: true } }) : null,
    ]);
    return {
      ...brand,
      branchName: branch?.name ?? '',
      serviceName: session?.service.name ?? null,
      therapistName: session?.therapist?.name ?? null,
      visitedAt: session?.completedAt ?? null,
      customerFirstName: customer?.name.split(' ')[0] ?? null,
      used: !!req.usedAt,
      expired: req.expiresAt < new Date(),
    };
  }

  async submitToken(token: string, input: { rating: number; comment?: string }) {
    const req = await this.loadRequest(token);
    if (req.usedAt) throw AppError.conflict('Thanks! You have already shared feedback for this visit.');
    if (req.expiresAt < new Date()) throw AppError.badRequest(ErrorCode.INVALID_STATE, 'This feedback link has expired.');
    const claimed = await this.db.feedbackRequest.updateMany({ where: { id: req.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!claimed.count) throw AppError.conflict('Thanks! You have already shared feedback for this visit.');
    const session = req.sessionId ? await this.db.therapySession.findFirst({ where: { id: req.sessionId }, select: { therapistId: true } }) : null;
    await this.record({
      tenantId: req.tenantId,
      branchId: req.branchId,
      rating: input.rating,
      comment: input.comment,
      source: 'IN_APP',
      customerId: req.customerId,
      sessionId: req.sessionId,
      therapistId: session?.therapistId ?? null,
    });
    return this.thankYou(req.branchId, input.rating);
  }

  /** Happy customers are invited to post a public review; unhappy ones are not (their feedback is escalated instead). */
  private async thankYou(branchId: string, rating: number) {
    const branch = await this.db.branch.findFirst({ where: { id: branchId }, select: { googleReviewUrl: true } });
    return { thanks: true, reviewUrl: rating >= 4 ? (branch?.googleReviewUrl ?? null) : null };
  }

  // ---- Public: branch QR code ----

  private async loadBranch(slug: string, code: string) {
    const tenant = await this.db.tenant.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!tenant || !['ACTIVE', 'ONBOARDING'].includes(tenant.status)) throw AppError.notFound('Business');
    const branch = await this.db.branch.findFirst({ where: { tenantId: tenant.id, code: code.toUpperCase(), status: 'ACTIVE' }, select: { id: true, name: true, address: true } });
    if (!branch) throw AppError.notFound('Branch');
    RequestContext.bindTenant(tenant.id);
    return { tenantId: tenant.id, branch };
  }

  async branchInfo(slug: string, code: string) {
    const { tenantId, branch } = await this.loadBranch(slug, code);
    return { ...(await this.branding(tenantId)), branchName: branch.name, branchAddress: branch.address };
  }

  async submitBranch(slug: string, code: string, input: { rating: number; comment?: string; name?: string; phone?: string }) {
    const { tenantId, branch } = await this.loadBranch(slug, code);
    let customerId: string | null = null;
    if (input.phone) {
      const digits = input.phone.replace(/\D/g, '').slice(-10);
      const c = await this.db.customer.findFirst({ where: { phone: { endsWith: digits } }, select: { id: true } });
      customerId = c?.id ?? null;
    }
    const comment = [input.comment, !customerId && (input.name || input.phone) ? `— ${[input.name, input.phone].filter(Boolean).join(', ')}` : null].filter(Boolean).join('\n') || null;
    await this.record({ tenantId, branchId: branch.id, rating: input.rating, comment, source: 'QR', customerId });
    return this.thankYou(branch.id, input.rating);
  }

  // ---- Staff ----

  private where(q: FeedbackQuery): Prisma.FeedbackWhereInput {
    const where: Prisma.FeedbackWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.therapistId) where.therapistId = q.therapistId;
    if (q.source) where.source = { in: q.source.split(',') as FeedbackSource[] };
    if (q.rating) where.rating = q.rating;
    else if (q.maxRating) where.rating = { lte: q.maxRating };
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) };
    if (q.search) where.comment = { contains: q.search, mode: 'insensitive' };
    return where;
  }

  async list(q: FeedbackQuery) {
    const where = this.where(q);
    // The summary ignores the rating filter so the distribution stays meaningful while drilling in.
    const summaryWhere = this.where({ ...q, rating: undefined, maxRating: undefined, search: undefined });
    const [items, total, dist, byTherapist, bySource] = await Promise.all([
      this.db.feedback.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.feedback.count({ where }),
      this.db.feedback.groupBy({ by: ['rating'], where: summaryWhere, _count: { _all: true } }),
      this.db.feedback.groupBy({ by: ['therapistId'], where: { ...summaryWhere, therapistId: { not: null } }, _avg: { rating: true }, _count: { _all: true } }),
      this.db.feedback.groupBy({ by: ['source'], where: summaryWhere, _count: { _all: true } }),
    ]);
    const [customers, therapists, branches, sessions] = await Promise.all([
      this.db.customer.findMany({ where: { id: { in: items.map((i) => i.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true, phone: true } }),
      this.db.therapist.findMany({ where: { id: { in: [...new Set([...items.map((i) => i.therapistId), ...byTherapist.map((t) => t.therapistId)].filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      this.db.branch.findMany({ select: { id: true, name: true } }),
      this.db.therapySession.findMany({ where: { id: { in: items.map((i) => i.sessionId).filter((x): x is string => !!x) } }, select: { id: true, service: { select: { name: true } } } }),
    ]);
    const cMap = new Map(customers.map((c) => [c.id, c]));
    const tMap = new Map(therapists.map((t) => [t.id, t.name]));
    const bMap = new Map(branches.map((b) => [b.id, b.name]));
    const sMap = new Map(sessions.map((s) => [s.id, s.service.name]));
    const result = paged(
      items.map((f) => ({
        ...f,
        customer: f.customerId ? (cMap.get(f.customerId) ?? null) : null,
        therapistName: f.therapistId ? (tMap.get(f.therapistId) ?? null) : null,
        branchName: bMap.get(f.branchId) ?? null,
        serviceName: f.sessionId ? (sMap.get(f.sessionId) ?? null) : null,
      })),
      total,
      q,
    );
    const count = dist.reduce((s, d) => s + d._count._all, 0);
    const distribution = [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: dist.find((d) => d.rating === r)?._count._all ?? 0 }));
    const sumRatings = dist.reduce((s, d) => s + d.rating * d._count._all, 0);
    const promoters = distribution.filter((d) => d.rating === 5).reduce((s, d) => s + d.count, 0);
    const detractors = distribution.filter((d) => d.rating <= 3).reduce((s, d) => s + d.count, 0);
    Object.assign(result.meta, {
      summary: {
        count,
        average: count ? round2(sumRatings / count) : null,
        distribution,
        // NPS-style score on a 5-point scale: 5★ promoters minus ≤3★ detractors.
        score: count ? Math.round(((promoters - detractors) / count) * 100) : null,
        lowRatings: distribution.filter((d) => d.rating <= 2).reduce((s, d) => s + d.count, 0),
        bySource: Object.fromEntries(bySource.map((s) => [s.source, s._count._all])),
        byTherapist: byTherapist
          .map((t) => ({ therapistId: t.therapistId, name: tMap.get(t.therapistId!) ?? 'Unknown', average: round2(t._avg.rating ?? 0), count: t._count._all }))
          .sort((a, b) => b.average - a.average || b.count - a.count),
      },
    });
    return result;
  }

  async createManual(input: { branchId: string; rating: number; comment?: string; customerId?: string; sessionId?: string; source: string }) {
    RequestContext.assertBranch(input.branchId);
    const tenantId = RequestContext.requireTenantId();
    let therapistId: string | null = null;
    let customerId = input.customerId ?? null;
    if (input.sessionId) {
      const s = await this.db.therapySession.findFirst({ where: { id: input.sessionId }, select: { therapistId: true, customerId: true, branchId: true } });
      if (!s) throw AppError.notFound('Session');
      if (s.branchId !== input.branchId) throw AppError.validation('The session belongs to a different branch.', { fields: { sessionId: 'Different branch' } });
      therapistId = s.therapistId;
      customerId ??= s.customerId;
    }
    if (customerId && !(await this.db.customer.findFirst({ where: { id: customerId }, select: { id: true } }))) throw AppError.notFound('Customer');
    const fb = await this.record({ tenantId, branchId: input.branchId, rating: input.rating, comment: input.comment, source: input.source as FeedbackSource, customerId, sessionId: input.sessionId ?? null, therapistId });
    await this.audit.log({ action: 'FEEDBACK_RECORDED', entityType: 'Feedback', entityId: fb.id, newValues: input });
    return fb;
  }

  /** Printable QR for the branch front desk; scanning opens the public branch feedback page. */
  async branchQr(branchId: string) {
    RequestContext.assertBranch(branchId);
    const tenantId = RequestContext.requireTenantId();
    const [tenant, branch] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, name: true } }),
      this.db.branch.findFirst({ where: { id: branchId }, select: { id: true, code: true, name: true, googleReviewUrl: true } }),
    ]);
    if (!tenant || !branch) throw AppError.notFound('Branch');
    const url = `${env().APP_URL}/feedback/${tenant.slug}/${branch.code.toLowerCase()}`;
    const png = await QRCode.toDataURL(url, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    return { branchId: branch.id, branchName: branch.name, businessName: tenant.name, url, png, googleReviewUrl: branch.googleReviewUrl };
  }

  async setReviewUrl(branchId: string, url: string | null) {
    RequestContext.assertBranch(branchId);
    await this.db.branch.update({ where: { id: branchId }, data: { googleReviewUrl: url } });
    await this.audit.log({ action: 'BRANCH_REVIEW_URL_SET', entityType: 'Branch', entityId: branchId, newValues: { googleReviewUrl: url } });
    return this.branchQr(branchId);
  }
}
