import { priceCart, PricingLine } from './pricing';

const service = (over: Partial<PricingLine> = {}): PricingLine => ({
  key: 's1',
  itemType: 'SERVICE',
  itemId: 'svc_swedish',
  name: 'Swedish Massage',
  quantity: 1,
  unitPrice: 2000,
  taxRate: 18,
  categoryId: 'cat_massage',
  ...over,
});
const product = (over: Partial<PricingLine> = {}): PricingLine => ({
  key: 'p1',
  itemType: 'PRODUCT',
  itemId: 'prd_oil',
  name: 'Massage oil',
  quantity: 2,
  unitPrice: 500,
  taxRate: 18,
  categoryId: 'cat_oils',
  ...over,
});
const base = { taxMode: 'EXCLUSIVE' as const, rounding: 'NONE' as const };

describe('priceCart', () => {
  it('applies exclusive tax on the net amount', () => {
    const r = priceCart([service()], base);
    expect(r.subtotal).toBe(2000);
    expect(r.tax).toBe(360);
    expect(r.total).toBe(2360);
  });

  it('extracts tax from inclusive prices', () => {
    const r = priceCart([service({ unitPrice: 1180 })], { ...base, taxMode: 'INCLUSIVE' });
    expect(r.lines[0].taxable).toBe(1000);
    expect(r.tax).toBe(180);
    expect(r.total).toBe(1180);
  });

  it('rounds the grand total and reports the rounding adjustment', () => {
    const r = priceCart([service({ unitPrice: 999 })], { ...base, rounding: 'NEAREST_1' });
    expect(r.total).toBe(1179);
    expect(r.rounding).toBe(0.18);
  });

  it('bills package-covered units at zero, including tax', () => {
    const r = priceCart([service({ quantity: 2, coveredQuantity: 1, coveredBy: 'PACKAGE' })], base);
    expect(r.breakdown.covered).toBe(2000);
    expect(r.total).toBe(2360);
    const full = priceCart([service({ coveredQuantity: 1, coveredBy: 'PACKAGE' })], base);
    expect(full.total).toBe(0);
    expect(full.tax).toBe(0);
  });

  it('caps a manual discount at the line value', () => {
    const r = priceCart([service({ manualDiscount: 5000 })], base);
    expect(r.lines[0].manualDiscountAmount).toBe(2000);
    expect(r.total).toBe(0);
  });

  it('applies the best membership discount only to matching item types', () => {
    const r = priceCart([service(), product()], {
      ...base,
      benefits: [
        { type: 'SERVICE_DISCOUNT_PERCENT', value: 10 },
        { type: 'SERVICE_DISCOUNT_PERCENT', value: 20, categoryId: 'cat_massage' },
        { type: 'PRODUCT_DISCOUNT_PERCENT', value: 5 },
      ],
    });
    expect(r.lines[0].membershipDiscount).toBe(400);
    expect(r.lines[1].membershipDiscount).toBe(50);
  });

  it('picks the single best offer per line instead of stacking', () => {
    const r = priceCart([service()], {
      ...base,
      offers: [
        { id: 'o1', name: '10% off', offerType: 'PERCENTAGE', value: 10, appliesTo: 'ALL', targetIds: [] },
        { id: 'o2', name: '300 off Swedish', offerType: 'FIXED', value: 300, appliesTo: 'SERVICE', targetIds: ['svc_swedish'] },
      ],
    });
    expect(r.lines[0].offerDiscount).toBe(300);
    expect(r.appliedOffers).toEqual([{ offerId: 'o2', name: '300 off Swedish', amount: 300 }]);
  });

  it('respects the offer minimum order on the gross subtotal', () => {
    const offer = { id: 'o1', name: 'Big spender', offerType: 'PERCENTAGE' as const, value: 10, appliesTo: 'ALL' as const, targetIds: [], minOrder: 2500 };
    expect(priceCart([service()], { ...base, offers: [offer] }).breakdown.offers).toBe(0);
    expect(priceCart([service(), product()], { ...base, offers: [offer] }).breakdown.offers).toBe(300);
  });

  it('gives every second unit free on buy-one-get-one', () => {
    const r = priceCart([product({ quantity: 5 })], {
      ...base,
      offers: [{ id: 'b1', name: 'BOGO oils', offerType: 'BUY_ONE_GET_ONE', value: 0, appliesTo: 'PRODUCT', targetIds: [] }],
    });
    expect(r.lines[0].offerDiscount).toBe(1000);
  });

  it('spreads an order-wide fixed offer across lines', () => {
    const r = priceCart([service(), product()], {
      ...base,
      offers: [{ id: 'f1', name: '300 off', offerType: 'FIXED', value: 300, appliesTo: 'ALL', targetIds: [] }],
    });
    expect(r.lines[0].offerDiscount + r.lines[1].offerDiscount).toBe(300);
    expect(r.lines[0].offerDiscount).toBe(200);
  });

  it('applies a percentage coupon after other discounts and caps it', () => {
    const r = priceCart([service()], {
      ...base,
      benefits: [{ type: 'SERVICE_DISCOUNT_PERCENT', value: 10 }],
      coupon: { id: 'c1', code: 'WELCOME20', discountType: 'PERCENTAGE', discountValue: 20, maximumDiscount: 300 },
    });
    expect(r.lines[0].membershipDiscount).toBe(200);
    expect(r.coupon).toEqual({ id: 'c1', code: 'WELCOME20', amount: 300 });
    expect(r.lines[0].taxable).toBe(1500);
    expect(r.total).toBe(1770);
  });

  it('rejects a coupon below its minimum order with a reason', () => {
    const r = priceCart([product({ quantity: 1 })], {
      ...base,
      coupon: { id: 'c1', code: 'FLAT500', discountType: 'FIXED', discountValue: 500, minimumOrder: 1000 },
    });
    expect(r.coupon).toBeNull();
    expect(r.couponError).toMatch(/minimum order/);
  });

  it('never lets discounts push a line below zero', () => {
    const r = priceCart([product({ quantity: 1, unitPrice: 100 })], {
      ...base,
      coupon: { id: 'c1', code: 'FLAT500', discountType: 'FIXED', discountValue: 500 },
    });
    expect(r.coupon?.amount).toBe(100);
    expect(r.total).toBe(0);
  });

  it('keeps line totals consistent with the invoice totals', () => {
    const r = priceCart([service({ quantity: 3, unitPrice: 1333.33 }), product({ quantity: 7, unitPrice: 99.99, taxRate: 5 })], {
      ...base,
      offers: [{ id: 'f1', name: '250 off', offerType: 'FIXED', value: 250, appliesTo: 'ALL', targetIds: [] }],
      coupon: { id: 'c1', code: 'X', discountType: 'PERCENTAGE', discountValue: 7 },
    });
    const lineSum = r.lines.reduce((s, l) => s + l.total, 0);
    expect(Math.abs(lineSum - r.total)).toBeLessThan(0.02);
    expect(Math.abs(r.subtotal - r.discount + r.tax - r.total)).toBeLessThan(0.02);
  });
});
