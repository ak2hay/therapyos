import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { safeEqual } from '../common/utils/crypto';
import { env } from '../config/env';

export interface CreateOrderResult {
  provider: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId?: string;
}

export interface RefundResult {
  provider: string;
  refundId: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
}

export interface ProviderSubscription {
  provider: string;
  subscriptionId: string;
  shortUrl?: string;
}

export abstract class PaymentProvider {
  abstract readonly name: string;
  abstract createOrder(amount: number, currency: string, receipt: string, notes?: Record<string, string>): Promise<CreateOrderResult>;
  abstract verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  abstract verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean;
  abstract refund(paymentId: string, amount: number): Promise<RefundResult>;
  abstract createSubscription(planRef: string, totalCount: number, notes?: Record<string, string>): Promise<ProviderSubscription>;
}

export const hmacHex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

/** Deterministic mock gateway: signatures are HMACs with a fixed dev secret so flows can be tested end to end. */
@Injectable()
export class MockPaymentProvider extends PaymentProvider {
  readonly name = 'mock';
  static readonly SECRET = 'mock_gateway_secret';

  async createOrder(amount: number, currency: string): Promise<CreateOrderResult> {
    return { provider: this.name, orderId: `order_mock_${randomBytes(6).toString('hex')}`, amount, currency, keyId: 'rzp_test_mock' };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return safeEqual(hmacHex(MockPaymentProvider.SECRET, `${orderId}|${paymentId}`), signature);
  }
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined) {
    return !!signature && safeEqual(hmacHex(MockPaymentProvider.SECRET, rawBody), signature);
  }
  async refund(): Promise<RefundResult> {
    return { provider: this.name, refundId: `rfnd_mock_${randomBytes(6).toString('hex')}`, status: 'SUCCESS' };
  }
  async createSubscription(): Promise<ProviderSubscription> {
    return { provider: this.name, subscriptionId: `sub_mock_${randomBytes(6).toString('hex')}` };
  }
}

@Injectable()
export class RazorpayPaymentProvider extends PaymentProvider {
  readonly name = 'razorpay';

  private async call<T>(path: string, body: unknown): Promise<T> {
    const e = env();
    const auth = Buffer.from(`${e.RAZORPAY_KEY_ID}:${e.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: { description: string } };
    if (!res.ok) throw new Error(json.error?.description ?? `Razorpay HTTP ${res.status}`);
    return json;
  }

  async createOrder(amount: number, currency: string, receipt: string, notes?: Record<string, string>) {
    const order = await this.call<{ id: string; amount: number; currency: string }>('/orders', {
      amount: Math.round(amount * 100),
      currency,
      receipt: receipt.slice(0, 40),
      notes,
    });
    return { provider: this.name, orderId: order.id, amount, currency: order.currency, keyId: env().RAZORPAY_KEY_ID };
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return safeEqual(hmacHex(env().RAZORPAY_KEY_SECRET ?? '', `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined) {
    const secret = env().RAZORPAY_WEBHOOK_SECRET;
    return !!signature && !!secret && safeEqual(hmacHex(secret, rawBody), signature);
  }

  async refund(paymentId: string, amount: number): Promise<RefundResult> {
    const r = await this.call<{ id: string; status: string }>(`/payments/${paymentId}/refund`, { amount: Math.round(amount * 100) });
    return { provider: this.name, refundId: r.id, status: r.status === 'processed' ? 'SUCCESS' : 'PENDING' };
  }

  async createSubscription(planRef: string, totalCount: number, notes?: Record<string, string>) {
    const s = await this.call<{ id: string; short_url?: string }>('/subscriptions', {
      plan_id: planRef,
      total_count: totalCount,
      customer_notify: 1,
      notes,
    });
    return { provider: this.name, subscriptionId: s.id, shortUrl: s.short_url };
  }
}
