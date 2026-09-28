import { Injectable } from '@nestjs/common';
import { ItemType } from '@prisma/client';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { num, RoundingMode } from '../../common/utils/money';
import { SettingsService } from '../../core/settings.service';
import { ServicesService } from '../catalog/services.service';
import { MembershipsService } from '../memberships/memberships.service';
import { CouponRejection, OffersService } from '../offers/offers.service';
import { MembershipBenefitRule, PricedLine, priceCart, PricingLine, PricingResult, TaxMode } from './pricing';

export interface CartLine {
  id: string;
  itemType: ItemType;
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  manualDiscount: number;
  therapistId?: string | null;
  sessionId?: string | null;
  customerPackageId?: string | null;
  customerMembershipId?: string | null;
}

export interface Coverage {
  by: 'PACKAGE' | 'MEMBERSHIP';
  quantity: number;
  customerPackageId?: string;
  membershipId?: string;
  benefitId?: string;
  label: string;
}

export interface QuoteLine extends PricedLine {
  coverage?: Coverage;
  warning?: string;
}

export interface Quote extends Omit<PricingResult, 'lines'> {
  lines: QuoteLine[];
  taxMode: TaxMode;
  roundingMode: RoundingMode;
  couponCode: string | null;
  couponId: string | null;
  warnings: string[];
}

export interface ResolvedItem {
  name: string;
  unitPrice: number;
  taxRate: number;
  categoryId: string | null;
}

@Injectable()
export class PricingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly services: ServicesService,
    private readonly memberships: MembershipsService,
    private readonly offers: OffersService,
  ) {}

  /** Current sell price and tax for a catalogue item at a branch. */
  async resolveItem(branchId: string, itemType: ItemType, itemId: string, client: DbOrTx = this.db): Promise<ResolvedItem> {
    switch (itemType) {
      case 'SERVICE': {
        const s = await this.services.effective(itemId, branchId, client);
        return { name: s.name, unitPrice: s.price, taxRate: s.taxRate, categoryId: s.categoryId };
      }
      case 'PRODUCT': {
        const p = await client.product.findFirst({ where: { id: itemId } });
        if (!p) throw AppError.notFound('Product');
        if (p.status !== 'ACTIVE' || !p.isRetail) throw AppError.invalidState(`${p.name} is not available for sale.`);
        return { name: p.name, unitPrice: num(p.sellingPrice), taxRate: num(p.taxRate), categoryId: p.categoryId };
      }
      case 'PACKAGE': {
        const p = await client.package.findFirst({ where: { id: itemId } });
        if (!p) throw AppError.notFound('Package');
        if (p.status !== 'ACTIVE') throw AppError.invalidState(`${p.name} is no longer on sale.`);
        return { name: p.name, unitPrice: num(p.price), taxRate: num(p.taxRate), categoryId: null };
      }
      case 'MEMBERSHIP': {
        const m = await client.membershipPlan.findFirst({ where: { id: itemId } });
        if (!m) throw AppError.notFound('Membership plan');
        if (m.status !== 'ACTIVE') throw AppError.invalidState(`${m.name} is no longer on sale.`);
        return { name: m.name, unitPrice: num(m.price), taxRate: num(m.taxRate), categoryId: null };
      }
    }
  }

  private async taxAndCategory(lines: CartLine[], client: DbOrTx) {
    const ids = (t: ItemType) => [...new Set(lines.filter((l) => l.itemType === t).map((l) => l.itemId))];
    const [services, products, packages, plans] = await Promise.all([
      client.service.findMany({ where: { id: { in: ids('SERVICE') } }, select: { id: true, taxRate: true, categoryId: true } }),
      client.product.findMany({ where: { id: { in: ids('PRODUCT') } }, select: { id: true, taxRate: true, categoryId: true } }),
      client.package.findMany({ where: { id: { in: ids('PACKAGE') } }, select: { id: true, taxRate: true } }),
      client.membershipPlan.findMany({ where: { id: { in: ids('MEMBERSHIP') } }, select: { id: true, taxRate: true } }),
    ]);
    const map = new Map<string, { taxRate: number; categoryId: string | null }>();
    for (const s of services) map.set(`SERVICE:${s.id}`, { taxRate: num(s.taxRate), categoryId: s.categoryId });
    for (const p of products) map.set(`PRODUCT:${p.id}`, { taxRate: num(p.taxRate), categoryId: p.categoryId });
    for (const p of packages) map.set(`PACKAGE:${p.id}`, { taxRate: num(p.taxRate), categoryId: null });
    for (const p of plans) map.set(`MEMBERSHIP:${p.id}`, { taxRate: num(p.taxRate), categoryId: null });
    return map;
  }

  /** Works out how many units of each service line a selected package or membership prepays. */
  private async coverage(lines: CartLine[], customerId: string | null, client: DbOrTx) {
    const out = new Map<string, { coverage?: Coverage; warning?: string }>();
    const allocated = new Map<string, number>();
    const now = new Date();
    for (const l of lines) {
      if (l.itemType !== 'SERVICE' || (!l.customerPackageId && !l.customerMembershipId)) continue;
      if (l.customerPackageId) {
        const cp = await client.customerPackage.findFirst({ where: { id: l.customerPackageId }, include: { items: true, package: { select: { name: true } } } });
        if (!cp || cp.customerId !== customerId) {
          out.set(l.id, { warning: 'Selected package does not belong to this customer.' });
          continue;
        }
        if (l.sessionId) {
          const done = await client.packageRedemption.findFirst({ where: { sessionId: l.sessionId, customerPackageId: cp.id, reversedAt: null } });
          if (done) {
            out.set(l.id, { coverage: { by: 'PACKAGE', quantity: 1, customerPackageId: cp.id, label: `${cp.package.name} (redeemed)` } });
            continue;
          }
        }
        const item = cp.items.find((i) => i.serviceId === l.itemId);
        if (!item) {
          out.set(l.id, { warning: `${cp.package.name} does not include ${l.name}.` });
          continue;
        }
        if (cp.status !== 'ACTIVE' || cp.expiresAt < now) {
          out.set(l.id, { warning: `${cp.package.name} is ${cp.expiresAt < now ? 'expired' : cp.status.toLowerCase().replace('_', ' ')}.` });
          continue;
        }
        const key = `pkg:${item.id}`;
        const left = item.totalQuantity - item.usedQuantity - (allocated.get(key) ?? 0);
        const qty = Math.min(l.quantity, Math.max(0, left));
        if (qty <= 0) {
          out.set(l.id, { warning: `No ${l.name} sessions left in ${cp.package.name}.` });
          continue;
        }
        allocated.set(key, (allocated.get(key) ?? 0) + qty);
        out.set(l.id, {
          coverage: { by: 'PACKAGE', quantity: qty, customerPackageId: cp.id, label: `${cp.package.name} · ${left - qty} left after this` },
          warning: qty < l.quantity ? `Only ${qty} of ${l.quantity} covered by ${cp.package.name}.` : undefined,
        });
      } else if (l.customerMembershipId) {
        const benefits = customerId ? await this.memberships.activeBenefits(customerId, client) : [];
        const service = await client.service.findFirst({ where: { id: l.itemId }, select: { categoryId: true } });
        const candidates = benefits.filter(
          (b) => b.membershipId === l.customerMembershipId && b.type === 'INCLUDED_SESSIONS' && (!b.serviceId || b.serviceId === l.itemId) && (!b.categoryId || b.categoryId === service?.categoryId),
        );
        if (l.sessionId && candidates.length) {
          const done = await client.membershipUsage.findFirst({ where: { customerMembershipId: l.customerMembershipId, sessionId: l.sessionId } });
          if (done) {
            out.set(l.id, { coverage: { by: 'MEMBERSHIP', quantity: 1, membershipId: l.customerMembershipId, benefitId: done.benefitId, label: `${candidates[0].membershipName} (used)` } });
            continue;
          }
        }
        const b = candidates.find((c) => (c.remaining ?? 0) - (allocated.get(`ben:${c.benefitId}`) ?? 0) > 0);
        if (!b) {
          out.set(l.id, { warning: candidates.length ? 'No included sessions left on this membership.' : 'This membership does not include this service.' });
          continue;
        }
        const key = `ben:${b.benefitId}`;
        const left = (b.remaining ?? 0) - (allocated.get(key) ?? 0);
        const qty = Math.min(l.quantity, left);
        allocated.set(key, (allocated.get(key) ?? 0) + qty);
        out.set(l.id, { coverage: { by: 'MEMBERSHIP', quantity: qty, membershipId: b.membershipId, benefitId: b.benefitId, label: `${b.membershipName} · ${left - qty} included left` } });
      }
    }
    return out;
  }

  /** Prices a set of cart lines with the tenant's tax mode, rounding, live offers, membership benefits and coupon. */
  async quote(input: { branchId: string; customerId: string | null; couponCode: string | null; lines: CartLine[] }, client: DbOrTx = this.db): Promise<Quote> {
    const tenantId = RequestContext.requireTenantId();
    const settings = await this.settings.getAll(tenantId);
    const taxMode = (settings.TAX_MODE as TaxMode) ?? 'EXCLUSIVE';
    const roundingMode = (settings.ROUNDING as RoundingMode) ?? 'NEAREST_1';
    const [meta, cover, offers, benefits] = await Promise.all([
      this.taxAndCategory(input.lines, client),
      this.coverage(input.lines, input.customerId, client),
      this.offers.activeRules(input.branchId, client),
      input.customerId ? this.memberships.activeBenefits(input.customerId, client) : Promise.resolve([]),
    ]);

    let couponError: string | undefined;
    let couponRule = null;
    let couponId: string | null = null;
    if (input.couponCode) {
      const res = await this.offers.check(input.couponCode, input.customerId, client);
      if (res instanceof CouponRejection) couponError = res.message;
      else {
        couponRule = res.rule;
        couponId = res.coupon.id;
      }
    }

    const pricingLines: PricingLine[] = input.lines.map((l) => {
      const m = meta.get(`${l.itemType}:${l.itemId}`);
      const c = cover.get(l.id)?.coverage;
      return {
        key: l.id,
        itemType: l.itemType,
        itemId: l.itemId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: m?.taxRate ?? 0,
        categoryId: m?.categoryId ?? null,
        manualDiscount: l.manualDiscount,
        coveredQuantity: c?.quantity ?? 0,
        coveredBy: c?.by ?? null,
      };
    });
    const benefitRules: MembershipBenefitRule[] = benefits
      .filter((b) => b.type === 'SERVICE_DISCOUNT_PERCENT' || b.type === 'PRODUCT_DISCOUNT_PERCENT')
      .map((b) => ({ type: b.type, serviceId: b.serviceId, categoryId: b.categoryId, value: b.value, membershipName: b.membershipName }));

    const result = priceCart(pricingLines, { taxMode, rounding: roundingMode, offers, benefits: benefitRules, coupon: couponRule });
    if (result.couponError) couponError = result.couponError;
    const lines: QuoteLine[] = result.lines.map((l) => ({ ...l, ...cover.get(l.key) }));
    const warnings = lines.filter((l) => l.warning).map((l) => `${l.name}: ${l.warning}`);
    return {
      ...result,
      lines,
      couponError,
      taxMode,
      roundingMode,
      couponCode: input.couponCode,
      couponId: result.coupon ? couponId : null,
      warnings,
    };
  }
}
