import { z } from 'zod';
import { PAYMENT_METHODS } from '@therapyos/types';
import { emptyToUndefined, id, isoDate, money, percent, recordStatus } from './common';

export const packageSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: emptyToUndefined(z.string().max(1000)),
  validityDays: z.coerce.number().int().min(1).max(3650),
  price: money,
  taxRate: percent.default(0),
  status: recordStatus.default('ACTIVE'),
  items: z
    .array(z.object({ serviceId: id, quantity: z.coerce.number().int().min(1).max(1000) }))
    .min(1, 'Add at least one service'),
});
export type PackageInput = z.infer<typeof packageSchema>;

export const membershipBenefitSchema = z.object({
  type: z.enum(['SERVICE_DISCOUNT_PERCENT', 'PRODUCT_DISCOUNT_PERCENT', 'INCLUDED_SESSIONS', 'PRIORITY_BOOKING']),
  serviceId: emptyToUndefined(id),
  categoryId: emptyToUndefined(id),
  value: z.coerce.number().min(0).default(0),
  quantity: emptyToUndefined(z.coerce.number().int().min(1)),
});

export const membershipPlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: emptyToUndefined(z.string().max(1000)),
  price: money,
  taxRate: percent.default(0),
  billingInterval: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'ONE_TIME']).default('MONTHLY'),
  durationDays: z.coerce.number().int().min(1).max(3650),
  status: recordStatus.default('ACTIVE'),
  benefits: z.array(membershipBenefitSchema).default([]),
});
export type MembershipPlanInput = z.infer<typeof membershipPlanSchema>;

export const offerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: emptyToUndefined(z.string().max(1000)),
  offerType: z.enum(['PERCENTAGE', 'FIXED', 'BUY_ONE_GET_ONE', 'PACKAGE_BONUS', 'MEMBERSHIP_BONUS']),
  value: z.coerce.number().min(0),
  appliesTo: z.enum(['ALL', 'SERVICE', 'CATEGORY', 'PRODUCT', 'PACKAGE', 'MEMBERSHIP']).default('ALL'),
  targetIds: z.array(id).default([]),
  branchIds: z.array(id).default([]),
  minOrder: emptyToUndefined(money),
  startDate: isoDate,
  endDate: isoDate,
  autoApply: z.boolean().default(true),
  status: recordStatus.default('ACTIVE'),
});
export type OfferInput = z.infer<typeof offerSchema>;

export const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,30}$/),
  description: emptyToUndefined(z.string().max(300)),
  discountType: z.enum(['PERCENTAGE', 'FIXED']),
  discountValue: z.coerce.number().min(0),
  minimumOrder: emptyToUndefined(money),
  maximumDiscount: emptyToUndefined(money),
  usageLimit: emptyToUndefined(z.coerce.number().int().min(1)),
  perCustomerLimit: emptyToUndefined(z.coerce.number().int().min(1)),
  startDate: isoDate,
  endDate: isoDate,
  status: recordStatus.default('ACTIVE'),
});
export type CouponInput = z.infer<typeof couponSchema>;

export const cartCreateSchema = z.object({ branchId: id, customerId: emptyToUndefined(id) });

export const cartItemSchema = z.object({
  itemType: z.enum(['SERVICE', 'PRODUCT', 'PACKAGE', 'MEMBERSHIP']),
  itemId: id,
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  therapistId: emptyToUndefined(id),
  sessionId: emptyToUndefined(id),
  customerPackageId: emptyToUndefined(id),
  customerMembershipId: emptyToUndefined(id),
  manualDiscount: emptyToUndefined(money),
  unitPriceOverride: emptyToUndefined(money),
});
export type CartItemInput = z.infer<typeof cartItemSchema>;

export const updateCartSchema = z.object({
  customerId: emptyToUndefined(id),
  couponCode: z.string().trim().toUpperCase().max(30).nullable().optional(),
});

export const checkoutSchema = z.object({
  notes: emptyToUndefined(z.string().max(1000)),
  payments: z
    .array(
      z.object({
        method: z.enum(PAYMENT_METHODS as [string, ...string[]]),
        amount: money,
        reference: emptyToUndefined(z.string().max(100)),
      }),
    )
    .default([]),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const invoiceFromSessionSchema = z.object({ sessionId: id });

export const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS as [string, ...string[]]),
  amount: money.refine((v) => v > 0, 'Amount must be positive'),
  reference: emptyToUndefined(z.string().max(100)),
  notes: emptyToUndefined(z.string().max(300)),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

export const razorpayOrderSchema = z.object({ invoiceId: id, amount: emptyToUndefined(money) });
export const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

export const refundSchema = z.object({
  paymentId: id,
  amount: money.refine((v) => v > 0),
  reason: z.string().trim().min(3).max(300),
});

export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const sellPackageSchema = z.object({
  customerId: id,
  packageId: id,
  branchId: id,
});

export const redeemPackageSchema = z.object({
  serviceId: id,
  quantity: z.coerce.number().int().min(1).default(1),
  sessionId: emptyToUndefined(id),
  branchId: id,
});

export const sellMembershipSchema = z.object({
  customerId: id,
  membershipPlanId: id,
  branchId: id,
  autoRenew: z.boolean().default(false),
  startDate: emptyToUndefined(isoDate),
});

export const validateCouponSchema = z.object({
  code: z.string().trim().toUpperCase(),
  customerId: emptyToUndefined(id),
  orderAmount: money,
});
