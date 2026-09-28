'use client';
import { api } from './api';

export interface QuoteLine {
  key: string;
  itemType: 'SERVICE' | 'PRODUCT' | 'PACKAGE' | 'MEMBERSHIP';
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  gross: number;
  coveredQuantity?: number;
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
  coverage?: { by: 'PACKAGE' | 'MEMBERSHIP'; quantity: number; label: string; customerPackageId?: string; membershipId?: string };
  warning?: string;
}

export interface Quote {
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  tax: number;
  rounding: number;
  total: number;
  breakdown: { covered: number; manual: number; membership: number; offers: number; coupon: number };
  appliedOffers: { offerId: string; name: string; amount: number }[];
  coupon: { id: string; code: string; amount: number } | null;
  couponError?: string;
  couponCode: string | null;
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE';
  warnings: string[];
}

export interface CartItem {
  id: string;
  itemType: QuoteLine['itemType'];
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  manualDiscount: number;
  therapistId: string | null;
  therapistName: string | null;
  sessionId: string | null;
  customerPackageId: string | null;
  customerMembershipId: string | null;
}

export interface Cart {
  id: string;
  branchId: string;
  customerId: string | null;
  status: 'OPEN' | 'CHECKED_OUT' | 'ABANDONED';
  couponCode: string | null;
  invoiceId: string | null;
  items: CartItem[];
  customer: { id: string; name: string; phone: string; customerCode: string; metrics?: { segment: string; visitCount: number } | null } | null;
  quote: Quote;
}

export interface PaymentRow {
  id: string;
  amount: number;
  refundedAmount: number;
  method: string;
  provider: string | null;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  status: string;
  reference: string | null;
  notes: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  branchId: string;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  rounding: number;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  balanceDue: number;
  refundable: number;
  currency: string;
  issuedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  notes: string | null;
  cancelReason: string | null;
  couponCode: string | null;
  appliedOffers: { offerId: string; name: string; amount: number }[];
  customer: { id: string; name: string; phone: string; customerCode: string } | null;
  branch: { id: string; name: string; code: string };
  items: {
    id: string;
    itemType: string;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRate: number;
    tax: number;
    total: number;
    sessionId: string | null;
    customerPackageId: string | null;
    meta: { coverageLabel?: string | null; offerDiscount?: number; couponDiscount?: number; membershipDiscount?: number; manualDiscount?: number; coveredAmount?: number } | null;
  }[];
  payments: PaymentRow[];
  refunds: { id: string; paymentId: string; amount: number; reason: string; status: string; createdAt: string }[];
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  RAZORPAY: 'Online (gateway)',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};
export const DESK_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const;

/** Opens the invoice PDF in a new tab (the request carries the auth header, so a plain link would not work). */
export async function openInvoicePdf(invoiceId: string) {
  const tab = window.open('', '_blank');
  const { blob } = await api.download(`/invoices/${invoiceId}/pdf`);
  const url = URL.createObjectURL(blob);
  if (tab) tab.location.href = url;
  else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface GatewayOrder {
  paymentId: string;
  provider: string;
  orderId: string;
  keyId?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  invoiceNumber: string;
  mock: boolean;
  prefill?: { name?: string; contact?: string; email?: string };
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (r: unknown) => void) => void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the payment gateway.'));
    document.body.appendChild(s);
  });
}

/**
 * Collects an online payment for an invoice. With the mock gateway (development) the payment is
 * completed server-side after confirmation; with Razorpay the standard checkout popup is used and
 * the result is verified by the API before anything is recorded.
 */
export async function collectOnline(invoiceId: string, amount: number | undefined, confirmMock: (order: GatewayOrder) => Promise<boolean>): Promise<InvoiceDetail | null> {
  const order = await api.post<GatewayOrder>('/payments/gateway/order', { invoiceId, amount });
  if (order.mock) {
    if (!(await confirmMock(order))) return null;
    return api.post<InvoiceDetail>(`/payments/${order.paymentId}/mock-complete`);
  }
  await loadRazorpay();
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: order.keyId,
      amount: order.amountMinor,
      currency: order.currency,
      order_id: order.orderId,
      name: order.invoiceNumber,
      prefill: order.prefill,
      handler: async (res: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          resolve(await api.post<InvoiceDetail>('/payments/gateway/verify', res));
        } catch (e) {
          reject(e);
        }
      },
      modal: { ondismiss: () => resolve(null) },
    });
    rzp.on('payment.failed', () => reject(new Error('Payment failed. No money has been taken.')));
    rzp.open();
  });
}
