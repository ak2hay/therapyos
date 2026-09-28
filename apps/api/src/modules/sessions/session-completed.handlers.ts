import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { FeatureFlagKey } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { round2 } from '../../common/utils/money';
import { DomainEvents, EventsService } from '../../core/events.service';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { OnDomainEvent } from '../../jobs/event-handlers';

export interface CommissionTier {
  minSessions: number;
  value: number;
}

/** Picks the highest tier whose threshold the monthly session count has reached. */
export function tierRate(tiers: CommissionTier[], monthlyCount: number): number {
  const sorted = [...tiers].sort((a, b) => a.minSessions - b.minSessions);
  let rate = 0;
  for (const t of sorted) if (monthlyCount >= t.minSessions) rate = t.value;
  return rate;
}

export function computeCommission(type: string, value: number, tiers: CommissionTier[] | null, base: number, monthlyCount: number) {
  switch (type) {
    case 'PERCENTAGE':
      return { rate: value, amount: round2((base * value) / 100) };
    case 'FIXED_PER_SESSION':
      return { rate: value, amount: round2(value) };
    case 'TIERED': {
      const rate = tierRate(tiers ?? [], monthlyCount);
      return { rate, amount: round2((base * rate) / 100) };
    }
    default:
      return { rate: 0, amount: 0 };
  }
}

@Injectable()
export class SessionCompletedHandlers {
  private readonly logger = new Logger(SessionCompletedHandlers.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly features: FeaturesService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
  ) {}

  /** One commission row per session (unique sessionId), so retries never double-pay. */
  @OnDomainEvent('session.completed')
  async commission(payload: Record<string, any>) {
    const tenantId = RequestContext.requireTenantId();
    if (!(await this.features.isEnabled(tenantId, FeatureFlagKey.COMMISSIONS))) return;
    const existing = await this.db.therapistCommission.findUnique({ where: { sessionId: payload.sessionId } });
    if (existing) return existing;
    const therapist = await this.db.therapist.findFirst({ where: { id: payload.therapistId } });
    if (!therapist || therapist.commissionType === 'NONE') return;

    const tz = await this.settings.timezone(tenantId);
    const completedAt = payload.completedAt ? new Date(payload.completedAt) : new Date();
    const monthStart = DateTime.fromJSDate(completedAt).setZone(tz).startOf('month').toJSDate();
    const monthlyCount = await this.db.therapySession.count({
      where: { therapistId: therapist.id, status: 'COMPLETED', completedAt: { gte: monthStart, lte: completedAt } },
    });
    const base = Number(payload.servicePrice ?? 0);
    const { rate, amount } = computeCommission(therapist.commissionType, Number(therapist.commissionValue), therapist.commissionTiers as CommissionTier[] | null, base, monthlyCount);
    if (amount <= 0) return;
    try {
      return await this.db.therapistCommission.create({
        data: { tenantId, branchId: payload.branchId, therapistId: therapist.id, sessionId: payload.sessionId, baseAmount: base, commissionType: therapist.commissionType, rate, amount, createdAt: completedAt },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }

  /** Creates a single-use feedback token for the session; the notification pipeline delivers the link. */
  @OnDomainEvent('session.completed')
  async feedbackRequest(payload: Record<string, any>) {
    const tenantId = RequestContext.requireTenantId();
    if (!(await this.settings.get<boolean>(tenantId, 'FEEDBACK_REQUEST_ENABLED'))) return;
    // Asking about a visit from days ago gets poor responses; late-processed events are skipped.
    if (payload.completedAt && Date.now() - new Date(payload.completedAt).getTime() > 2 * 86_400_000) return;
    const existing = await this.db.feedbackRequest.findUnique({ where: { sessionId: payload.sessionId } });
    if (existing) return existing;
    try {
      const request = await this.db.$transaction(async (tx) => {
        const r = await tx.feedbackRequest.create({
          data: {
            tenantId,
            branchId: payload.branchId,
            sessionId: payload.sessionId,
            customerId: payload.customerId,
            token: randomBytes(18).toString('base64url'),
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        });
        await this.events.publish(DomainEvents.FEEDBACK_REQUESTED, { feedbackRequestId: r.id, customerId: payload.customerId, sessionId: payload.sessionId, branchId: payload.branchId }, tx);
        return r;
      });
      return request;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      this.logger.warn(`Feedback request failed for session ${payload.sessionId}: ${(e as Error).message}`);
      throw e;
    }
  }
}
