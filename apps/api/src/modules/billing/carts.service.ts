import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@therapyos/types';
import { CartItemInput, CheckoutInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { advisoryLock } from '../../common/prisma/locks';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { num, round2 } from '../../common/utils/money';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService } from '../ledger/ledger.service';
import { MembershipsService } from '../memberships/memberships.service';
import { CouponRejection, OffersService } from '../offers/offers.service';
import { PackagesService } from '../packages/packages.service';
import { maskContact } from '../customers/customers.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';
import { CartLine, PricingService, Quote } from './pricing.service';

const cartInclude = {
  items: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CartInclude;

type CartRow = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

export interface CheckoutOptions {
  /** Backdates the invoice and payments (used by imports and the demo seed). */
  at?: Date;
}

@Injectable()
export class CartsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly packages: PackagesService,
    private readonly memberships: MembershipsService,
    private readonly offers: OffersService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
    private readonly inventory: InventoryService,
  ) {}

  private lines(cart: CartRow): CartLine[] {
    return cart.items.map((i) => ({
      id: i.id,
      itemType: i.itemType,
      itemId: i.itemId,
      name: i.name,
      quantity: i.quantity,
      unitPrice: num(i.unitPrice),
      manualDiscount: num(i.manualDiscount),
      therapistId: i.therapistId,
      sessionId: i.sessionId,
      customerPackageId: i.customerPackageId,
      customerMembershipId: i.customerMembershipId,
    }));
  }

  private async load(id: string, client: DbOrTx = this.db) {
    const cart = await client.cart.findFirst({ where: { id }, include: cartInclude });
    if (!cart) throw AppError.notFound('Cart');
    RequestContext.assertBranch(cart.branchId);
    return cart;
  }

  private async loadOpen(id: string, client: DbOrTx = this.db) {
    const cart = await this.load(id, client);
    if (cart.status !== 'OPEN') throw AppError.invalidState(cart.status === 'CHECKED_OUT' ? 'This bill has already been checked out.' : 'This cart was abandoned.');
    return cart;
  }

  async view(id: string) {
    const cart = await this.load(id);
    const [quote, customer, therapists] = await Promise.all([
      this.pricing.quote({ branchId: cart.branchId, customerId: cart.customerId, couponCode: cart.couponCode, lines: this.lines(cart) }),
      cart.customerId
        ? this.db.customer.findFirst({ where: { id: cart.customerId }, select: { id: true, name: true, phone: true, email: true, customerCode: true, metrics: { select: { segment: true, visitCount: true } } } })
        : null,
      this.db.therapist.findMany({ where: { id: { in: cart.items.map((i) => i.therapistId).filter((t): t is string => !!t) } }, select: { id: true, name: true } }),
    ]);
    const therapistName = new Map(therapists.map((t) => [t.id, t.name]));
    return {
      ...cart,
      items: cart.items.map((i) => ({ ...i, therapistName: i.therapistId ? therapistName.get(i.therapistId) ?? null : null })),
      customer: customer ? maskContact(customer) : null,
      quote,
    };
  }

  async listOpen(branchId?: string) {
    const carts = await this.db.cart.findMany({
      where: { status: 'OPEN', ...RequestContext.branchFilter(branchId), items: { some: {} } },
      include: { items: { select: { name: true, quantity: true, unitPrice: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    const customers = await this.db.customer.findMany({ where: { id: { in: carts.map((c) => c.customerId).filter((c): c is string => !!c) } }, select: { id: true, name: true } });
    const byId = new Map(customers.map((c) => [c.id, c.name]));
    return carts.map((c) => ({ id: c.id, branchId: c.branchId, customerName: c.customerId ? byId.get(c.customerId) ?? null : null, itemCount: c.items.length, estimate: round2(c.items.reduce((s, i) => s + num(i.unitPrice) * i.quantity, 0)), updatedAt: c.updatedAt, items: c.items.map((i) => i.name) }));
  }

  async create(input: { branchId: string; customerId?: string }) {
    RequestContext.assertBranch(input.branchId);
    const tenantId = RequestContext.requireTenantId();
    const branch = await this.db.branch.findFirst({ where: { id: input.branchId } });
    if (!branch) throw AppError.notFound('Branch');
    if (input.customerId) await this.assertCustomer(input.customerId);
    const cart = await this.db.cart.create({ data: { tenantId, branchId: input.branchId, customerId: input.customerId, createdBy: RequestContext.userId ?? null } });
    return this.view(cart.id);
  }

  private async assertCustomer(id: string) {
    const c = await this.db.customer.findFirst({ where: { id }, select: { id: true, status: true } });
    if (!c) throw AppError.notFound('Customer');
    if (c.status === 'BLOCKED') throw AppError.invalidState('This customer is blocked.');
  }

  async update(id: string, input: { customerId?: string; couponCode?: string | null }) {
    const cart = await this.loadOpen(id);
    const data: Prisma.CartUpdateInput = {};
    if (input.customerId !== undefined && input.customerId !== cart.customerId) {
      await this.assertCustomer(input.customerId);
      if (cart.items.some((i) => i.sessionId || i.customerPackageId || i.customerMembershipId)) {
        throw AppError.invalidState('This bill has session or package lines for another customer; remove them first.');
      }
      data.customerId = input.customerId;
    }
    if (input.couponCode !== undefined) {
      if (input.couponCode) {
        const res = await this.offers.check(input.couponCode, input.customerId ?? cart.customerId);
        if (res instanceof CouponRejection) throw AppError.badRequest(res.code, res.message);
        data.couponCode = res.coupon.code;
      } else data.couponCode = null;
    }
    await this.db.cart.update({ where: { id }, data });
    return this.view(id);
  }

  async addItem(cartId: string, input: CartItemInput) {
    const cart = await this.loadOpen(cartId);
    const resolved = await this.pricing.resolveItem(cart.branchId, input.itemType, input.itemId);
    const needsCustomer = input.itemType === 'PACKAGE' || input.itemType === 'MEMBERSHIP' || input.customerPackageId || input.customerMembershipId || input.sessionId;
    if (needsCustomer && !cart.customerId) throw AppError.validation('Select a customer before adding packages, memberships or sessions.');
    if ((input.itemType === 'PACKAGE' || input.itemType === 'MEMBERSHIP') && input.quantity > 1) throw AppError.validation('Sell one package or membership per line.');
    if ((input.customerPackageId || input.customerMembershipId) && input.itemType !== 'SERVICE') throw AppError.validation('Packages and memberships can only cover services.');
    this.assertDiscountAllowed(input.manualDiscount, input.unitPriceOverride);
    const session = input.sessionId ? await this.assertSessionBillable(input.sessionId, cart.customerId!, cart.id) : null;
    if (session && !input.therapistId) input = { ...input, therapistId: session.therapistId };
    if (input.therapistId) {
      const t = await this.db.therapist.findFirst({ where: { id: input.therapistId }, select: { id: true } });
      if (!t) throw AppError.notFound('Therapist');
    }

    const unitPrice = input.unitPriceOverride ?? resolved.unitPrice;
    const mergeable = !input.sessionId && !input.customerPackageId && !input.customerMembershipId && input.unitPriceOverride === undefined && !input.manualDiscount && (input.itemType === 'PRODUCT' || input.itemType === 'SERVICE');
    const same = mergeable ? cart.items.find((i) => i.itemType === input.itemType && i.itemId === input.itemId && !i.sessionId && !i.customerPackageId && !i.customerMembershipId && (i.therapistId ?? null) === (input.therapistId ?? null) && num(i.unitPrice) === unitPrice) : undefined;
    if (same) {
      await this.db.cartItem.update({ where: { id: same.id }, data: { quantity: same.quantity + input.quantity } });
    } else {
      await this.db.cartItem.create({
        data: {
          cartId,
          itemType: input.itemType,
          itemId: input.itemId,
          name: resolved.name,
          quantity: input.quantity,
          unitPrice,
          manualDiscount: input.manualDiscount ?? 0,
          therapistId: input.therapistId,
          sessionId: input.sessionId,
          customerPackageId: input.customerPackageId,
          customerMembershipId: input.customerMembershipId,
        },
      });
    }
    await this.db.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
    if (input.unitPriceOverride !== undefined && input.unitPriceOverride !== resolved.unitPrice) {
      await this.audit.log({ action: 'PRICE_OVERRIDDEN', entityType: 'Cart', entityId: cartId, oldValues: { unitPrice: resolved.unitPrice }, newValues: { itemType: input.itemType, itemId: input.itemId, unitPrice } });
    }
    return this.view(cartId);
  }

  private assertDiscountAllowed(manualDiscount?: number, override?: number) {
    if ((manualDiscount && manualDiscount > 0) || override !== undefined) {
      if (!RequestContext.hasPermission(PERMISSIONS.DISCOUNT_APPLY)) throw AppError.forbidden('Manual discounts and price overrides need manager approval.');
    }
  }

  private async assertSessionBillable(sessionId: string, customerId: string, cartId: string) {
    const s = await this.db.therapySession.findFirst({ where: { id: sessionId }, select: { customerId: true, status: true, invoiceId: true, therapistId: true } });
    if (!s) throw AppError.notFound('Session');
    if (s.customerId !== customerId) throw AppError.validation('Session belongs to a different customer.');
    if (s.status === 'CANCELLED') throw AppError.invalidState('Cancelled sessions cannot be billed.');
    if (s.invoiceId) throw AppError.conflict('This session has already been billed.');
    const other = await this.db.cartItem.findFirst({ where: { sessionId, cart: { status: 'OPEN', id: { not: cartId } } }, select: { cartId: true } });
    if (other) throw AppError.conflict('This session is already on another open bill.');
    return s;
  }

  async updateItem(cartId: string, itemId: string, input: { quantity?: number; manualDiscount?: number; therapistId?: string | null; customerPackageId?: string | null; customerMembershipId?: string | null }) {
    const cart = await this.loadOpen(cartId);
    const item = cart.items.find((i) => i.id === itemId);
    if (!item) throw AppError.notFound('Cart item');
    this.assertDiscountAllowed(input.manualDiscount);
    if ((item.itemType === 'PACKAGE' || item.itemType === 'MEMBERSHIP' || item.sessionId) && input.quantity && input.quantity !== item.quantity) throw AppError.validation('Quantity cannot be changed for this line.');
    if ((input.customerPackageId || input.customerMembershipId) && item.itemType !== 'SERVICE') throw AppError.validation('Packages and memberships can only cover services.');
    await this.db.cartItem.update({
      where: { id: itemId },
      data: {
        quantity: input.quantity,
        manualDiscount: input.manualDiscount,
        therapistId: input.therapistId,
        customerPackageId: input.customerPackageId,
        customerMembershipId: input.customerMembershipId,
      },
    });
    return this.view(cartId);
  }

  async removeItem(cartId: string, itemId: string) {
    const cart = await this.loadOpen(cartId);
    if (!cart.items.some((i) => i.id === itemId)) throw AppError.notFound('Cart item');
    await this.db.cartItem.delete({ where: { id: itemId } });
    return this.view(cartId);
  }

  async abandon(cartId: string) {
    await this.loadOpen(cartId);
    await this.db.cart.update({ where: { id: cartId }, data: { status: 'ABANDONED' } });
    return { id: cartId, status: 'ABANDONED' };
  }

  /** Opens (or reuses) a bill for a completed session with the service line pre-filled. */
  async fromSession(sessionId: string) {
    const s = await this.db.therapySession.findFirst({ where: { id: sessionId }, include: { service: { select: { name: true } } } });
    if (!s) throw AppError.notFound('Session');
    RequestContext.assertBranch(s.branchId);
    if (s.invoiceId) throw AppError.conflict('This session has already been billed.');
    if (s.status === 'CANCELLED') throw AppError.invalidState('Cancelled sessions cannot be billed.');
    const existing = await this.db.cartItem.findFirst({ where: { sessionId, cart: { status: 'OPEN' } }, select: { cartId: true } });
    if (existing) return this.view(existing.cartId);
    const cart = await this.db.cart.create({ data: { tenantId: s.tenantId, branchId: s.branchId, customerId: s.customerId, createdBy: RequestContext.userId ?? null } });
    return this.addItem(cart.id, {
      itemType: 'SERVICE',
      itemId: s.serviceId,
      quantity: 1,
      therapistId: s.therapistId,
      sessionId: s.id,
      customerPackageId: s.customerPackageId ?? undefined,
      customerMembershipId: s.customerMembershipId ?? undefined,
    });
  }

  /**
   * Converts the cart into an issued invoice in one transaction: prices it, numbers it, records
   * offers/coupon usage, redeems package and membership coverage, creates pending package and
   * membership purchases, posts the ledger journal and applies any payments taken at the desk.
   */
  async checkout(cartId: string, input: CheckoutInput, opts: CheckoutOptions = {}) {
    const at = opts.at ?? new Date();
    const invoiceId = await this.db.$transaction(
      async (tx) => {
        await advisoryLock(tx, `cart:${cartId}`);
        const cart = await this.loadOpen(cartId, tx);
        if (!cart.items.length) throw AppError.badRequest(ErrorCode.CART_EMPTY, 'Add at least one item to the bill.');
        const quote = await this.pricing.quote({ branchId: cart.branchId, customerId: cart.customerId, couponCode: cart.couponCode, lines: this.lines(cart) }, tx);
        if (cart.couponCode && !quote.coupon) throw AppError.badRequest(ErrorCode.COUPON_INVALID, quote.couponError ?? 'Coupon cannot be applied.');
        for (const item of cart.items) {
          if (item.customerPackageId || item.customerMembershipId) {
            const line = quote.lines.find((l) => l.key === item.id);
            if (!line?.coverage) throw AppError.badRequest(item.customerPackageId ? ErrorCode.PACKAGE_INACTIVE : ErrorCode.MEMBERSHIP_INACTIVE, `${item.name}: ${line?.warning ?? 'coverage unavailable'}`);
          }
          if (item.sessionId) {
            const s = await tx.therapySession.findFirst({ where: { id: item.sessionId }, select: { invoiceId: true } });
            if (s?.invoiceId) throw AppError.conflict(`${item.name} has already been billed.`);
          }
        }
        const paymentsTotal = round2(input.payments.reduce((s, p) => s + p.amount, 0));
        if (paymentsTotal > quote.total + 0.001) throw AppError.badRequest(ErrorCode.PAYMENT_EXCEEDS_BALANCE, `Payments (${paymentsTotal.toFixed(2)}) exceed the bill total (${quote.total.toFixed(2)}).`);

        const invoiceNumber = await this.invoices.nextNumber(tx, cart.branchId);
        const invoice = await tx.invoice.create({
          data: {
            tenantId: cart.tenantId,
            branchId: cart.branchId,
            customerId: cart.customerId,
            invoiceNumber,
            subtotal: quote.subtotal,
            discount: quote.discount,
            tax: quote.tax,
            rounding: quote.rounding,
            total: quote.total,
            status: 'ISSUED',
            issuedAt: at,
            notes: input.notes,
            couponId: quote.couponId,
            cartId: cart.id,
            createdBy: RequestContext.userId ?? null,
            createdAt: at,
          },
        });

        for (const item of cart.items) {
          const line = quote.lines.find((l) => l.key === item.id)!;
          const meta: Record<string, unknown> = {
            coveredQuantity: line.coveredQuantity ?? 0,
            coveredAmount: line.coveredAmount,
            manualDiscount: line.manualDiscountAmount,
            membershipDiscount: line.membershipDiscount,
            offerDiscount: line.offerDiscount,
            couponDiscount: line.couponDiscount,
            offerId: line.offerId ?? null,
            coverageLabel: line.coverage?.label ?? null,
          };
          let customerPackageId = item.customerPackageId;
          let customerMembershipId = item.customerMembershipId;
          if (item.itemType === 'PACKAGE') {
            const cp = await this.packages.createPending(tx, { customerId: cart.customerId!, packageId: item.itemId, branchId: cart.branchId, invoiceId: invoice.id });
            customerPackageId = cp.id;
          } else if (item.itemType === 'MEMBERSHIP') {
            const m = await this.memberships.createPending(tx, { customerId: cart.customerId!, planId: item.itemId, branchId: cart.branchId, invoiceId: invoice.id });
            customerMembershipId = m.id;
          } else if (line.coverage?.by === 'PACKAGE') {
            const r = await this.packages.redeem({ customerPackageId: line.coverage.customerPackageId!, serviceId: item.itemId, quantity: line.coverage.quantity, sessionId: item.sessionId, branchId: cart.branchId, at }, tx);
            meta.redemptionId = r.id;
          } else if (line.coverage?.by === 'MEMBERSHIP') {
            const u = await this.memberships.recordUsage(tx, { membershipId: line.coverage.membershipId!, benefitId: line.coverage.benefitId!, quantity: line.coverage.quantity, sessionId: item.sessionId, invoiceId: invoice.id });
            meta.membershipUsageId = u.id;
          }
          await tx.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              itemType: item.itemType,
              itemId: item.itemId,
              description: item.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discount: line.discount,
              taxRate: line.taxRate,
              tax: line.tax,
              total: line.total,
              therapistId: item.therapistId,
              sessionId: item.sessionId,
              customerPackageId,
              customerMembershipId,
              meta: meta as Prisma.InputJsonValue,
            },
          });
          if (item.sessionId) await tx.therapySession.update({ where: { id: item.sessionId }, data: { invoiceId: invoice.id } });
        }

        for (const o of quote.appliedOffers) {
          await tx.offerRedemption.create({ data: { tenantId: cart.tenantId, offerId: o.offerId, invoiceId: invoice.id, customerId: cart.customerId, discountAmount: o.amount, createdAt: at } });
        }
        if (quote.coupon) {
          await this.offers.claim(tx, quote.coupon.id);
          await tx.couponRedemption.create({ data: { tenantId: cart.tenantId, couponId: quote.coupon.id, customerId: cart.customerId, invoiceId: invoice.id, discountAmount: quote.coupon.amount, createdAt: at } });
        }

        const items = await tx.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
        await this.ledger.invoiceIssued(tx, { ...invoice, items });
        await this.inventory.sellForInvoice(
          tx,
          invoice,
          items.filter((i) => i.itemType === 'PRODUCT').map((i) => ({ itemId: i.itemId, quantity: num(i.quantity) })),
        );
        await this.events.publish(DomainEvents.INVOICE_ISSUED, { invoiceId: invoice.id, invoiceNumber, customerId: cart.customerId, branchId: cart.branchId, total: quote.total }, tx);
        await tx.cart.update({ where: { id: cart.id }, data: { status: 'CHECKED_OUT', invoiceId: invoice.id } });

        for (const p of input.payments.filter((x) => x.amount > 0)) {
          await this.payments.recordInTx(tx, invoice.id, { method: p.method, amount: p.amount, reference: p.reference, notes: undefined }, at);
        }
        await this.invoices.settle(tx, invoice.id, at);
        return invoice.id;
      },
      { timeout: 30_000 },
    );
    const detail = await this.invoices.detail(invoiceId);
    await this.audit.log({ action: 'INVOICE_CREATED', entityType: 'Invoice', entityId: invoiceId, newValues: { invoiceNumber: detail.invoiceNumber, total: detail.total, payments: input.payments } });
    this.realtime.toBranch(detail.branchId, 'invoices.changed', { id: invoiceId });
    return detail;
  }

  /** Convenience for selling a package or membership outside the POS screen: issues an unpaid invoice. */
  async sellDirect(input: { branchId: string; customerId: string; itemType: 'PACKAGE' | 'MEMBERSHIP'; itemId: string; autoRenew?: boolean; startDate?: string }) {
    const cart = await this.create({ branchId: input.branchId, customerId: input.customerId });
    await this.addItem(cart.id, { itemType: input.itemType, itemId: input.itemId, quantity: 1 });
    const invoice = await this.checkout(cart.id, { payments: [] });
    if (input.itemType === 'MEMBERSHIP' && (input.autoRenew || input.startDate)) {
      await this.db.customerMembership.updateMany({
        where: { purchaseInvoiceId: invoice.id, status: 'PENDING_PAYMENT' },
        data: { autoRenew: input.autoRenew ?? false, ...(input.startDate ? { startedAt: new Date(`${input.startDate}T00:00:00.000Z`) } : {}) },
      });
    }
    return invoice;
  }
}

export type { Quote };
