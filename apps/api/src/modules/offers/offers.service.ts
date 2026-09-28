import { Injectable } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { CouponInput, OfferInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { dateOnly, todayIn } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import type { CouponRule, OfferRule } from '../billing/pricing';

export class CouponRejection {
  constructor(
    public readonly code: ErrorCode,
    public readonly message: string,
  ) {}
}

@Injectable()
export class OffersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async today() {
    return dateOnly(todayIn(await this.settings.timezone(RequestContext.requireTenantId())));
  }

  private assertDates(start: string, end: string) {
    if (end < start) throw AppError.validation('End date must be on or after the start date.', [{ path: 'endDate', message: 'End date must be on or after the start date' }]);
  }

  // ---------- offers ----------

  async listOffers(q: { status?: string; current?: boolean }) {
    const today = await this.today();
    const where: Prisma.OfferWhereInput = {};
    if (q.status) where.status = q.status as never;
    if (q.current) Object.assign(where, { status: 'ACTIVE', startDate: { lte: today }, endDate: { gte: today } });
    const [offers, usage] = await Promise.all([
      this.db.offer.findMany({ where, orderBy: [{ status: 'asc' }, { endDate: 'desc' }] }),
      this.db.offerRedemption.groupBy({ by: ['offerId'], _count: { _all: true }, _sum: { discountAmount: true } }),
    ]);
    const byOffer = new Map(usage.map((u) => [u.offerId, u]));
    return offers.map((o) => ({
      ...o,
      redemptions: byOffer.get(o.id)?._count._all ?? 0,
      discountGiven: num(byOffer.get(o.id)?._sum.discountAmount),
      live: o.status === 'ACTIVE' && o.startDate <= today && o.endDate >= today,
    }));
  }

  async getOffer(id: string) {
    const o = await this.db.offer.findFirst({ where: { id } });
    if (!o) throw AppError.notFound('Offer');
    return o;
  }

  async createOffer(input: OfferInput) {
    this.assertDates(input.startDate, input.endDate);
    if (input.offerType === 'PERCENTAGE' && input.value > 100) throw AppError.validation('Percentage offers cannot exceed 100%.');
    for (const b of input.branchIds) RequestContext.assertBranch(b);
    const offer = await this.db.offer.create({
      data: { ...input, tenantId: RequestContext.requireTenantId(), startDate: dateOnly(input.startDate), endDate: dateOnly(input.endDate) },
    });
    await this.audit.log({ action: 'OFFER_CREATED', entityType: 'Offer', entityId: offer.id, newValues: input });
    return offer;
  }

  async updateOffer(id: string, input: Partial<OfferInput>) {
    const before = await this.getOffer(id);
    const start = input.startDate ?? before.startDate.toISOString().slice(0, 10);
    const end = input.endDate ?? before.endDate.toISOString().slice(0, 10);
    this.assertDates(start, end);
    const offer = await this.db.offer.update({
      where: { id },
      data: { ...input, startDate: input.startDate ? dateOnly(input.startDate) : undefined, endDate: input.endDate ? dateOnly(input.endDate) : undefined },
    });
    await this.audit.log({ action: 'OFFER_UPDATED', entityType: 'Offer', entityId: id, oldValues: { value: before.value, status: before.status }, newValues: input });
    return offer;
  }

  /** Auto-applied offers live today for a branch, in the shape the pricing engine consumes. */
  async activeRules(branchId: string, client: DbOrTx = this.db): Promise<OfferRule[]> {
    const today = await this.today();
    const offers = await client.offer.findMany({
      where: { status: 'ACTIVE', autoApply: true, startDate: { lte: today }, endDate: { gte: today }, OR: [{ branchIds: { isEmpty: true } }, { branchIds: { has: branchId } }] },
    });
    return offers.map((o) => ({ id: o.id, name: o.name, offerType: o.offerType, value: num(o.value), appliesTo: o.appliesTo, targetIds: o.targetIds, minOrder: o.minOrder ? num(o.minOrder) : null }));
  }

  // ---------- coupons ----------

  async listCoupons(q: { status?: string; search?: string }) {
    const where: Prisma.CouponWhereInput = {};
    if (q.status) where.status = q.status as never;
    if (q.search) where.code = { contains: q.search.toUpperCase() };
    const [coupons, usage] = await Promise.all([
      this.db.coupon.findMany({ where, orderBy: [{ status: 'asc' }, { endDate: 'desc' }] }),
      this.db.couponRedemption.groupBy({ by: ['couponId'], _sum: { discountAmount: true } }),
    ]);
    const today = await this.today();
    const byCoupon = new Map(usage.map((u) => [u.couponId, num(u._sum.discountAmount)]));
    return coupons.map((c) => ({ ...c, discountGiven: byCoupon.get(c.id) ?? 0, live: c.status === 'ACTIVE' && c.startDate <= today && c.endDate >= today && (!c.usageLimit || c.usedCount < c.usageLimit) }));
  }

  async getCoupon(id: string) {
    const c = await this.db.coupon.findFirst({ where: { id } });
    if (!c) throw AppError.notFound('Coupon');
    return c;
  }

  async createCoupon(input: CouponInput) {
    this.assertDates(input.startDate, input.endDate);
    if (input.discountType === 'PERCENTAGE' && input.discountValue > 100) throw AppError.validation('Percentage coupons cannot exceed 100%.');
    const exists = await this.db.coupon.findFirst({ where: { code: input.code } });
    if (exists) throw AppError.conflict(`Coupon code ${input.code} already exists.`, ErrorCode.DUPLICATE);
    const coupon = await this.db.coupon.create({
      data: { ...input, tenantId: RequestContext.requireTenantId(), startDate: dateOnly(input.startDate), endDate: dateOnly(input.endDate) },
    });
    await this.audit.log({ action: 'COUPON_CREATED', entityType: 'Coupon', entityId: coupon.id, newValues: input });
    return coupon;
  }

  async updateCoupon(id: string, input: Partial<CouponInput>) {
    const before = await this.getCoupon(id);
    if (input.code && input.code !== before.code) {
      const exists = await this.db.coupon.findFirst({ where: { code: input.code } });
      if (exists) throw AppError.conflict(`Coupon code ${input.code} already exists.`, ErrorCode.DUPLICATE);
    }
    this.assertDates(input.startDate ?? before.startDate.toISOString().slice(0, 10), input.endDate ?? before.endDate.toISOString().slice(0, 10));
    const coupon = await this.db.coupon.update({
      where: { id },
      data: { ...input, startDate: input.startDate ? dateOnly(input.startDate) : undefined, endDate: input.endDate ? dateOnly(input.endDate) : undefined },
    });
    await this.audit.log({ action: 'COUPON_UPDATED', entityType: 'Coupon', entityId: id, oldValues: { discountValue: before.discountValue, status: before.status }, newValues: input });
    return coupon;
  }

  /** Checks everything about a coupon except the order minimum (the pricing engine enforces that on the discounted base). */
  async check(code: string, customerId: string | null | undefined, client: DbOrTx = this.db): Promise<{ coupon: Coupon; rule: CouponRule } | CouponRejection> {
    const coupon = await client.coupon.findFirst({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || coupon.status !== 'ACTIVE') return new CouponRejection(ErrorCode.COUPON_INVALID, `Coupon ${code} is not valid.`);
    const today = await this.today();
    if (coupon.startDate > today) return new CouponRejection(ErrorCode.COUPON_INVALID, `Coupon ${coupon.code} is not active yet.`);
    if (coupon.endDate < today) return new CouponRejection(ErrorCode.COUPON_EXPIRED, `Coupon ${coupon.code} has expired.`);
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return new CouponRejection(ErrorCode.COUPON_LIMIT_REACHED, `Coupon ${coupon.code} has been fully used.`);
    if (coupon.perCustomerLimit) {
      if (!customerId) return new CouponRejection(ErrorCode.COUPON_INVALID, `Select a customer to use coupon ${coupon.code}.`);
      const used = await client.couponRedemption.count({ where: { couponId: coupon.id, customerId } });
      if (used >= coupon.perCustomerLimit) return new CouponRejection(ErrorCode.COUPON_LIMIT_REACHED, `This customer has already used coupon ${coupon.code}.`);
    }
    return {
      coupon,
      rule: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: num(coupon.discountValue),
        minimumOrder: coupon.minimumOrder ? num(coupon.minimumOrder) : null,
        maximumDiscount: coupon.maximumDiscount ? num(coupon.maximumDiscount) : null,
      },
    };
  }

  /** Standalone validation endpoint: returns the discount the coupon would give on an order amount. */
  async validate(code: string, customerId: string | undefined, orderAmount: number) {
    const res = await this.check(code, customerId);
    if (res instanceof CouponRejection) throw AppError.badRequest(res.code, res.message);
    const { rule } = res;
    if (rule.minimumOrder && orderAmount < rule.minimumOrder) throw AppError.badRequest(ErrorCode.COUPON_MIN_ORDER, `Coupon ${rule.code} needs a minimum order of ${rule.minimumOrder}.`);
    let discount = rule.discountType === 'PERCENTAGE' ? round2((orderAmount * rule.discountValue) / 100) : rule.discountValue;
    if (rule.maximumDiscount) discount = Math.min(discount, rule.maximumDiscount);
    return { valid: true, couponId: rule.id, code: rule.code, discount: round2(Math.min(discount, orderAmount)) };
  }

  /** Claims one use atomically so concurrent checkouts cannot exceed the usage limit. */
  async claim(tx: DbOrTx, couponId: string) {
    const res = await tx.$executeRaw`UPDATE coupons SET "usedCount" = "usedCount" + 1 WHERE id = ${couponId} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    if (res === 0) throw AppError.badRequest(ErrorCode.COUPON_LIMIT_REACHED, 'This coupon has just been fully used.');
  }

  async release(tx: DbOrTx, couponId: string) {
    await tx.$executeRaw`UPDATE coupons SET "usedCount" = GREATEST("usedCount" - 1, 0) WHERE id = ${couponId}`;
  }
}
