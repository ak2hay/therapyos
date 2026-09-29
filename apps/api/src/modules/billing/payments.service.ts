import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PaymentInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { advisoryLock } from '../../common/prisma/locks';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { hmacHex, MockPaymentProvider, PaymentProvider } from '../../integrations/payment.provider';
import { ProviderFactory } from '../../integrations/provider.factory';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { LedgerService } from '../ledger/ledger.service';
import { maskContact } from '../customers/customers.service';
import { InvoicesService } from './invoices.service';

const PAID_LIKE: PaymentStatus[] = ['SUCCESS', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const NON_CASH_METHODS: string[] = ['PACKAGE', 'MEMBERSHIP'];

export interface PaymentListQuery {
  page: number;
  pageSize: number;
  branchId?: string;
  method?: string;
  status?: string;
  invoiceId?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderFactory,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(q: PaymentListQuery) {
    const where: Prisma.PaymentWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.method) where.method = { in: q.method.split(',') as PaymentMethod[] };
    if (q.status) where.status = { in: q.status.split(',') as PaymentStatus[] };
    if (q.invoiceId) where.invoiceId = q.invoiceId;
    if (q.from || q.to) {
      const tz = await this.settings.timezone(RequestContext.requireTenantId());
      where.createdAt = {
        ...(q.from ? { gte: DateTime.fromISO(q.from, { zone: tz }).startOf('day').toJSDate() } : {}),
        ...(q.to ? { lte: DateTime.fromISO(q.to, { zone: tz }).endOf('day').toJSDate() } : {}),
      };
    }
    const [items, total, byMethod] = await Promise.all([
      this.db.payment.findMany({
        where,
        include: { invoice: { select: { id: true, invoiceNumber: true, customer: { select: { id: true, name: true, phone: true, email: true } } } }, branch: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.payment.count({ where }),
      this.db.payment.groupBy({ by: ['method'], where: { ...where, status: { in: PAID_LIKE } }, _sum: { amount: true, refundedAmount: true } }),
    ]);
    const result = paged(
      items.map((p) => ({ ...p, invoice: { ...p.invoice, customer: p.invoice.customer ? maskContact(p.invoice.customer) : null } })),
      total,
      q,
    );
    Object.assign(result.meta, {
      summary: byMethod.map((m) => ({ method: m.method, collected: num(m._sum.amount), refunded: num(m._sum.refundedAmount), net: round2(num(m._sum.amount) - num(m._sum.refundedAmount)) })),
    });
    return result;
  }

  private assertPayable(inv: { status: string; invoiceNumber: string }) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIALLY_PAID') {
      throw AppError.badRequest(ErrorCode.INVOICE_NOT_PAYABLE, `${inv.invoiceNumber} is ${inv.status.toLowerCase().replace('_', ' ')} and cannot take payments.`);
    }
  }

  /** Records an offline payment (cash, UPI, card terminal, bank transfer) inside a caller's transaction. */
  async recordInTx(tx: DbOrTx, invoiceId: string, input: PaymentInput, at = new Date()) {
    if (NON_CASH_METHODS.includes(input.method)) throw AppError.validation('Packages and memberships are applied as coverage on the bill, not as payments.');
    if (input.method === 'RAZORPAY') throw AppError.validation('Online payments are recorded through the payment gateway.');
    await advisoryLock(tx, `invoice:${invoiceId}`);
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!inv) throw AppError.notFound('Invoice');
    this.assertPayable(inv);
    const balance = round2(num(inv.total) - num(inv.amountPaid));
    if (input.amount > balance + 0.001) throw AppError.badRequest(ErrorCode.PAYMENT_EXCEEDS_BALANCE, `Amount exceeds the balance due of ${balance.toFixed(2)}.`, { balance });
    const payment = await tx.payment.create({
      data: {
        tenantId: inv.tenantId,
        branchId: inv.branchId,
        invoiceId,
        customerId: inv.customerId,
        amount: input.amount,
        method: input.method as PaymentMethod,
        status: 'SUCCESS',
        reference: input.reference,
        notes: input.notes,
        receivedBy: RequestContext.userId ?? null,
        paidAt: at,
        createdAt: at,
      },
    });
    await this.ledger.paymentReceived(tx, { id: payment.id, branchId: inv.branchId, amount: input.amount, method: payment.method, invoiceNumber: inv.invoiceNumber, paidAt: at });
    await this.events.publish(DomainEvents.PAYMENT_RECEIVED, { paymentId: payment.id, invoiceId, customerId: inv.customerId, branchId: inv.branchId, amount: input.amount, method: payment.method }, tx);
    await this.invoices.settle(tx, invoiceId, at);
    return payment;
  }

  async record(invoiceId: string, input: PaymentInput) {
    const inv = await this.invoices.get(invoiceId);
    const payment = await this.db.$transaction((tx) => this.recordInTx(tx, invoiceId, input));
    await this.audit.log({ action: 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id, newValues: { invoiceId, amount: input.amount, method: input.method } });
    this.realtime.toBranch(inv.branchId, 'invoices.changed', { id: invoiceId });
    return this.invoices.detail(invoiceId);
  }

  // ---------- payment gateway ----------

  /** The gateway account that created this payment's order. */
  private gatewayFor(p: { tenantId: string; gatewayKeyId: string | null; provider: string | null }): Promise<PaymentProvider> {
    return this.providers.paymentsForKey(p.tenantId, p.gatewayKeyId, p.provider);
  }

  async createOrder(invoiceId: string, amount?: number) {
    const tenantId = RequestContext.requireTenantId();
    const inv = await this.invoices.get(invoiceId);
    this.assertPayable(inv);
    const balance = round2(num(inv.total) - num(inv.amountPaid));
    const value = round2(amount ?? balance);
    if (value <= 0 || value > balance + 0.001) throw AppError.badRequest(ErrorCode.PAYMENT_EXCEEDS_BALANCE, `Amount must be between 1 and the balance due of ${balance.toFixed(2)}.`);
    const gateway = await this.providers.payments(tenantId);
    let order;
    try {
      order = await gateway.createOrder(value, inv.currency, inv.invoiceNumber, { invoiceId, tenantId });
    } catch (e) {
      throw AppError.badRequest(ErrorCode.PROVIDER_ERROR, `Payment gateway error: ${(e as Error).message}`);
    }
    const payment = await this.db.payment.create({
      data: {
        tenantId,
        branchId: inv.branchId,
        invoiceId,
        customerId: inv.customerId,
        amount: value,
        method: 'RAZORPAY',
        provider: order.provider,
        providerOrderId: order.orderId,
        gatewayKeyId: gateway.keyId,
        status: 'PENDING',
        receivedBy: RequestContext.userId ?? null,
      },
    });
    return {
      paymentId: payment.id,
      provider: order.provider,
      orderId: order.orderId,
      keyId: order.keyId,
      amount: value,
      amountMinor: Math.round(value * 100),
      currency: order.currency,
      invoiceNumber: inv.invoiceNumber,
      mock: gateway.name === 'mock',
      prefill: inv.customer ? { name: inv.customer.name, contact: inv.customer.phone, email: inv.customer.email } : undefined,
    };
  }

  async verify(input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
    const payment = await this.db.payment.findFirst({ where: { providerOrderId: input.razorpay_order_id } });
    if (!payment) throw AppError.notFound('Payment order');
    RequestContext.assertBranch(payment.branchId);
    const gateway = await this.gatewayFor(payment);
    if (!gateway.verifyPaymentSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
      await this.db.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED', notes: 'Signature verification failed' } });
      throw AppError.badRequest(ErrorCode.PAYMENT_FAILED, 'Payment could not be verified. No money has been recorded.');
    }
    await this.capture(payment.id, input.razorpay_payment_id);
    this.realtime.toBranch(payment.branchId, 'invoices.changed', { id: payment.invoiceId });
    return this.invoices.detail(payment.invoiceId);
  }

  /** Development helper: completes a mock-gateway order as if the customer paid in the checkout popup. */
  async mockComplete(paymentId: string) {
    const p = await this.db.payment.findFirst({ where: { id: paymentId } });
    if (!p || !p.providerOrderId) throw AppError.notFound('Payment order');
    if ((await this.gatewayFor(p)).name !== 'mock') throw AppError.forbidden('Mock payments are only available with the mock gateway.');
    const paymentRef = `pay_mock_${p.id.slice(-10)}`;
    return this.verify({ razorpay_order_id: p.providerOrderId, razorpay_payment_id: paymentRef, razorpay_signature: hmacHex(MockPaymentProvider.SECRET, `${p.providerOrderId}|${paymentRef}`) });
  }

  /** Marks a gateway payment successful exactly once, whether the client callback or the webhook arrives first. */
  async capture(paymentId: string, providerTransactionId: string, at = new Date()) {
    return this.db.$transaction(async (tx) => {
      const current = await tx.payment.findFirst({ where: { id: paymentId } });
      if (!current) throw AppError.notFound('Payment');
      await advisoryLock(tx, `invoice:${current.invoiceId}`);
      const p = await tx.payment.findFirst({ where: { id: paymentId }, include: { invoice: { select: { invoiceNumber: true, customerId: true } } } });
      if (PAID_LIKE.includes(p!.status)) return p!;
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCESS', providerTransactionId, paidAt: at } });
      await this.ledger.paymentReceived(tx, { id: paymentId, branchId: p!.branchId, amount: num(p!.amount), method: 'RAZORPAY', invoiceNumber: p!.invoice.invoiceNumber, paidAt: at });
      await this.events.publish(DomainEvents.PAYMENT_RECEIVED, { paymentId, invoiceId: p!.invoiceId, customerId: p!.invoice.customerId, branchId: p!.branchId, amount: num(p!.amount), method: 'RAZORPAY' }, tx);
      await this.invoices.settle(tx, p!.invoiceId, at);
      return p!;
    });
  }

  /**
   * Gateway webhook (public, signature-verified against the raw body). Webhooks carry no
   * tenant, so the payment is found by its gateway order id and processed in its tenant.
   */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined, body: any) {
    const event: string = body?.event ?? '';
    const paymentEntity = body?.payload?.payment?.entity ?? {};
    const refundEntity = body?.payload?.refund?.entity ?? {};
    // Businesses may use their own Razorpay account, so the secret depends on which order the event is for.
    // Nothing is changed before the signature is verified.
    const payment = paymentEntity.order_id ? await this.db.payment.findFirst({ where: { providerOrderId: paymentEntity.order_id } }) : null;
    const refund = refundEntity.id ? await this.db.refund.findFirst({ where: { providerRefundId: refundEntity.id }, include: { payment: true } }) : null;
    const owner = payment ?? refund?.payment ?? null;
    const gateway = owner ? await this.gatewayFor(owner) : await this.providers.payments(null);
    if (!rawBody || !gateway.verifyWebhookSignature(rawBody, signature)) {
      throw AppError.badRequest(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid webhook signature.');
    }
    if (event === 'payment.captured' || event === 'order.paid' || event === 'payment.failed') {
      const entity = paymentEntity;
      if (!payment) return { received: true, ignored: 'unknown order' };
      return RequestContext.runAsTenant(payment.tenantId, async () => {
        if (event === 'payment.failed') {
          await this.db.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED', notes: entity.error_description ?? 'Payment failed at gateway' } });
        } else {
          await this.capture(payment.id, entity.id ?? `gw_${payment.id}`);
          this.realtime.toBranch(payment.branchId, 'invoices.changed', { id: payment.invoiceId });
        }
        return { received: true, event };
      });
    }
    if (event === 'refund.processed' || event === 'refund.failed') {
      const entity = refundEntity;
      if (!refund) return { received: true, ignored: 'unknown refund' };
      await this.db.refund.update({ where: { id: refund.id }, data: { status: event === 'refund.processed' ? 'SUCCESS' : 'FAILED' } });
      if (event === 'refund.failed') this.logger.error(`Gateway refund ${entity.id} failed for invoice ${refund.invoiceId}; follow up manually.`);
      return { received: true, event };
    }
    return { received: true, ignored: event };
  }

  // ---------- refunds ----------

  async refund(input: { paymentId: string; amount: number; reason: string }) {
    const p = await this.db.payment.findFirst({ where: { id: input.paymentId }, include: { invoice: { select: { id: true, invoiceNumber: true, customerId: true, branchId: true } } } });
    if (!p) throw AppError.notFound('Payment');
    RequestContext.assertBranch(p.branchId);
    if (!PAID_LIKE.includes(p.status)) throw AppError.invalidState('Only successful payments can be refunded.');
    const refundable = round2(num(p.amount) - num(p.refundedAmount));
    if (input.amount > refundable + 0.001) throw AppError.badRequest(ErrorCode.REFUND_EXCEEDS_PAYMENT, `At most ${refundable.toFixed(2)} can be refunded on this payment.`, { refundable });

    let providerRefundId: string | null = null;
    let status: 'SUCCESS' | 'PENDING' = 'SUCCESS';
    if (p.method === 'RAZORPAY' && p.providerTransactionId) {
      try {
        const r = await (await this.gatewayFor(p)).refund(p.providerTransactionId, input.amount);
        if (r.status === 'FAILED') throw new Error('Gateway rejected the refund');
        providerRefundId = r.refundId;
        status = r.status;
      } catch (e) {
        throw AppError.badRequest(ErrorCode.PROVIDER_ERROR, `Refund failed at the payment gateway: ${(e as Error).message}`);
      }
    }

    const refund = await this.db.$transaction(async (tx) => {
      await advisoryLock(tx, `invoice:${p.invoiceId}`);
      const fresh = await tx.payment.findFirst({ where: { id: p.id } });
      const left = round2(num(fresh!.amount) - num(fresh!.refundedAmount));
      if (input.amount > left + 0.001) throw AppError.badRequest(ErrorCode.REFUND_EXCEEDS_PAYMENT, `At most ${left.toFixed(2)} can be refunded on this payment.`);
      // Gateway refunds in PENDING are treated as committed; the webhook only confirms or flags them.
      const r = await tx.refund.create({
        data: { tenantId: p.tenantId, branchId: p.branchId, paymentId: p.id, invoiceId: p.invoiceId, amount: input.amount, reason: input.reason, status: 'SUCCESS', providerRefundId, createdBy: RequestContext.userId ?? null },
      });
      const refundedAmount = round2(num(fresh!.refundedAmount) + input.amount);
      await tx.payment.update({ where: { id: p.id }, data: { refundedAmount, status: refundedAmount >= num(fresh!.amount) - 0.001 ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
      await this.ledger.refundIssued(tx, { id: r.id, branchId: p.branchId, amount: input.amount, method: p.method, invoiceNumber: p.invoice.invoiceNumber });
      await this.invoices.settle(tx, p.invoiceId);
      if (p.invoice.customerId) {
        await this.activity.record({ customerId: p.invoice.customerId, branchId: p.branchId, type: 'REFUND', title: `Refund of ${input.amount.toFixed(2)} on ${p.invoice.invoiceNumber}`, refType: 'Refund', refId: r.id, meta: { reason: input.reason } }, tx);
      }
      await this.events.publish(DomainEvents.PAYMENT_REFUNDED, { refundId: r.id, paymentId: p.id, invoiceId: p.invoiceId, customerId: p.invoice.customerId, branchId: p.branchId, amount: input.amount, gatewayStatus: status }, tx);
      return r;
    });
    await this.audit.log({ action: 'REFUND_ISSUED', entityType: 'Refund', entityId: refund.id, newValues: { paymentId: p.id, invoiceId: p.invoiceId, amount: input.amount, reason: input.reason, providerRefundId } });
    this.realtime.toBranch(p.branchId, 'invoices.changed', { id: p.invoiceId });
    return this.invoices.detail(p.invoiceId);
  }
}
