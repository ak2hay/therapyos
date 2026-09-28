import { applyRounding, round2, RoundingMode } from '../../common/utils/money';

export type LineType = 'SERVICE' | 'PRODUCT' | 'PACKAGE' | 'MEMBERSHIP';
export type TaxMode = 'EXCLUSIVE' | 'INCLUSIVE';

export interface PricingLine {
  key: string;
  itemType: LineType;
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  categoryId?: string | null;
  manualDiscount?: number;
  /** Units prepaid by a package or included membership sessions; these are billed at zero. */
  coveredQuantity?: number;
  coveredBy?: 'PACKAGE' | 'MEMBERSHIP' | null;
}

export interface MembershipBenefitRule {
  type: 'SERVICE_DISCOUNT_PERCENT' | 'PRODUCT_DISCOUNT_PERCENT' | 'INCLUDED_SESSIONS' | 'PRIORITY_BOOKING';
  serviceId?: string | null;
  categoryId?: string | null;
  value: number;
  membershipName?: string;
}

export interface OfferRule {
  id: string;
  name: string;
  offerType: 'PERCENTAGE' | 'FIXED' | 'BUY_ONE_GET_ONE' | 'PACKAGE_BONUS' | 'MEMBERSHIP_BONUS';
  value: number;
  appliesTo: 'ALL' | 'SERVICE' | 'CATEGORY' | 'PRODUCT' | 'PACKAGE' | 'MEMBERSHIP';
  targetIds: string[];
  minOrder?: number | null;
}

export interface CouponRule {
  id: string;
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  minimumOrder?: number | null;
  maximumDiscount?: number | null;
}

export interface PricingContext {
  taxMode: TaxMode;
  rounding: RoundingMode;
  benefits?: MembershipBenefitRule[];
  offers?: OfferRule[];
  coupon?: CouponRule | null;
}

export interface PricedLine extends PricingLine {
  gross: number;
  coveredAmount: number;
  manualDiscountAmount: number;
  membershipDiscount: number;
  offerDiscount: number;
  couponDiscount: number;
  discount: number;
  taxable: number;
  tax: number;
  total: number;
  offerId?: string;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  tax: number;
  rounding: number;
  total: number;
  breakdown: { covered: number; manual: number; membership: number; offers: number; coupon: number };
  appliedOffers: { offerId: string; name: string; amount: number }[];
  coupon: { id: string; code: string; amount: number } | null;
  couponError?: string;
}

function offerMatches(offer: OfferRule, line: PricingLine): boolean {
  const target = (id?: string | null) => !offer.targetIds.length || (!!id && offer.targetIds.includes(id));
  switch (offer.appliesTo) {
    case 'ALL':
      return true;
    case 'SERVICE':
      return line.itemType === 'SERVICE' && target(line.itemId);
    case 'CATEGORY':
      return (line.itemType === 'SERVICE' || line.itemType === 'PRODUCT') && target(line.categoryId);
    case 'PRODUCT':
      return line.itemType === 'PRODUCT' && target(line.itemId);
    case 'PACKAGE':
      return line.itemType === 'PACKAGE' && target(line.itemId);
    case 'MEMBERSHIP':
      return line.itemType === 'MEMBERSHIP' && target(line.itemId);
  }
}

/** Discount an offer yields on one line given the amount still payable on it. */
function lineOfferDiscount(offer: OfferRule, line: PricingLine, remaining: number, payableUnits: number): number {
  if (remaining <= 0 || !offerMatches(offer, line)) return 0;
  switch (offer.offerType) {
    case 'PERCENTAGE':
    case 'PACKAGE_BONUS':
    case 'MEMBERSHIP_BONUS':
      return round2((remaining * Math.min(offer.value, 100)) / 100);
    case 'FIXED':
      // Line-targeted fixed offers are per unit; order-wide fixed offers are handled separately.
      return offer.appliesTo === 'ALL' ? 0 : Math.min(remaining, round2(offer.value * payableUnits));
    case 'BUY_ONE_GET_ONE': {
      const free = Math.floor(payableUnits / 2);
      return Math.min(remaining, round2(free * line.unitPrice));
    }
  }
}

/** Splits an order-level amount across lines proportionally to their remaining value (last line absorbs rounding). */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const out = weights.map((w) => round2((amount * w) / total));
  const diff = round2(amount - out.reduce((s, v) => s + v, 0));
  const last = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0).pop();
  if (last !== undefined) out[last] = round2(out[last] + diff);
  return out;
}

/**
 * Prices a cart. Order of application, each on what is still payable:
 * package/membership coverage -> manual discount -> membership benefit -> best offer per line
 * -> order-wide fixed offers -> coupon -> tax (inclusive or exclusive) -> rounding.
 * Offers do not stack with each other on the same line; the best one wins.
 */
export function priceCart(input: PricingLine[], ctx: PricingContext): PricingResult {
  const offers = ctx.offers ?? [];
  const benefits = ctx.benefits ?? [];
  const lines: PricedLine[] = input.map((l) => {
    const quantity = Math.max(1, Math.floor(l.quantity));
    const covered = Math.min(quantity, Math.max(0, Math.floor(l.coveredQuantity ?? 0)));
    const gross = round2(l.unitPrice * quantity);
    const coveredAmount = round2(l.unitPrice * covered);
    return {
      ...l,
      quantity,
      coveredQuantity: covered,
      gross,
      coveredAmount,
      manualDiscountAmount: 0,
      membershipDiscount: 0,
      offerDiscount: 0,
      couponDiscount: 0,
      discount: 0,
      taxable: 0,
      tax: 0,
      total: 0,
    };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.gross, 0));
  const remaining = (l: PricedLine) => round2(l.gross - l.coveredAmount - l.manualDiscountAmount - l.membershipDiscount - l.offerDiscount - l.couponDiscount);

  for (const l of lines) {
    l.manualDiscountAmount = Math.min(Math.max(0, round2(l.manualDiscount ?? 0)), remaining(l));

    const applicable = benefits.filter((b) => {
      if (b.type === 'SERVICE_DISCOUNT_PERCENT') {
        return l.itemType === 'SERVICE' && (!b.serviceId || b.serviceId === l.itemId) && (!b.categoryId || b.categoryId === l.categoryId);
      }
      return b.type === 'PRODUCT_DISCOUNT_PERCENT' && l.itemType === 'PRODUCT' && (!b.categoryId || b.categoryId === l.categoryId);
    });
    const bestPct = Math.min(100, Math.max(0, ...applicable.map((b) => b.value)));
    if (bestPct > 0) l.membershipDiscount = round2((remaining(l) * bestPct) / 100);
  }

  const eligibleOffers = offers.filter((o) => !o.minOrder || subtotal >= o.minOrder);
  const appliedOffers = new Map<string, { offerId: string; name: string; amount: number }>();
  for (const l of lines) {
    const payableUnits = l.quantity - (l.coveredQuantity ?? 0);
    let best: { offer: OfferRule; amount: number } | null = null;
    for (const o of eligibleOffers) {
      const amount = lineOfferDiscount(o, l, remaining(l), payableUnits);
      if (amount > 0 && (!best || amount > best.amount)) best = { offer: o, amount };
    }
    if (best) {
      l.offerDiscount = best.amount;
      l.offerId = best.offer.id;
      const a = appliedOffers.get(best.offer.id) ?? { offerId: best.offer.id, name: best.offer.name, amount: 0 };
      a.amount = round2(a.amount + best.amount);
      appliedOffers.set(best.offer.id, a);
    }
  }
  // Order-wide fixed amount offers (e.g. "Rs 200 off above Rs 2000").
  for (const o of eligibleOffers.filter((x) => x.offerType === 'FIXED' && x.appliesTo === 'ALL')) {
    const open = lines.map(remaining);
    const amount = Math.min(o.value, round2(open.reduce((s, v) => s + v, 0)));
    if (amount <= 0) continue;
    allocate(amount, open).forEach((share, i) => (lines[i].offerDiscount = round2(lines[i].offerDiscount + share)));
    const a = appliedOffers.get(o.id) ?? { offerId: o.id, name: o.name, amount: 0 };
    a.amount = round2(a.amount + amount);
    appliedOffers.set(o.id, a);
  }

  let coupon: PricingResult['coupon'] = null;
  let couponError: string | undefined;
  if (ctx.coupon) {
    const c = ctx.coupon;
    const open = lines.map(remaining);
    const base = round2(open.reduce((s, v) => s + v, 0));
    if (c.minimumOrder && base < c.minimumOrder) {
      couponError = `Coupon ${c.code} needs a minimum order of ${c.minimumOrder}.`;
    } else {
      let amount = c.discountType === 'PERCENTAGE' ? round2((base * Math.min(c.discountValue, 100)) / 100) : c.discountValue;
      if (c.maximumDiscount) amount = Math.min(amount, c.maximumDiscount);
      amount = round2(Math.min(amount, base));
      if (amount > 0) {
        allocate(amount, open).forEach((share, i) => (lines[i].couponDiscount = share));
        coupon = { id: c.id, code: c.code, amount };
      } else couponError = `Coupon ${c.code} does not apply to this order.`;
    }
  }

  for (const l of lines) {
    l.discount = round2(l.coveredAmount + l.manualDiscountAmount + l.membershipDiscount + l.offerDiscount + l.couponDiscount);
    const net = Math.max(0, round2(l.gross - l.discount));
    if (ctx.taxMode === 'INCLUSIVE') {
      l.tax = round2(net - net / (1 + l.taxRate / 100));
      l.taxable = round2(net - l.tax);
      l.total = net;
    } else {
      l.taxable = net;
      l.tax = round2((net * l.taxRate) / 100);
      l.total = round2(net + l.tax);
    }
  }

  const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  const beforeRounding = round2(lines.reduce((s, l) => s + l.total, 0));
  const { total, rounding } = applyRounding(beforeRounding, ctx.rounding);
  const sumOf = (k: 'coveredAmount' | 'manualDiscountAmount' | 'membershipDiscount' | 'offerDiscount' | 'couponDiscount') => round2(lines.reduce((s, l) => s + l[k], 0));
  return {
    lines,
    subtotal,
    discount,
    tax,
    rounding,
    total: Math.max(0, total),
    breakdown: { covered: sumOf('coveredAmount'), manual: sumOf('manualDiscountAmount'), membership: sumOf('membershipDiscount'), offers: sumOf('offerDiscount'), coupon: sumOf('couponDiscount') },
    appliedOffers: [...appliedOffers.values()],
    coupon,
    couponError,
  };
}
