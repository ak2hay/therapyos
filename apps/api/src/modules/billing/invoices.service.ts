import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { advisoryLock } from '../../common/prisma/locks';
import { AppError } from '../../common/errors/app-error';
import { formatInZone } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { StorageService } from '../../integrations/storage.service';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService } from '../ledger/ledger.service';
import { MembershipsService } from '../memberships/memberships.service';
import { OffersService } from '../offers/offers.service';
import { PackagesService } from '../packages/packages.service';
import { maskContact } from '../customers/customers.service';
import { renderInvoicePdf } from './invoice-pdf';

export interface InvoiceListQuery {
  page: number;
  pageSize: number;
  search?: string;
  branchId?: string;
  customerId?: string;
  status?: string;
  from?: string;
  to?: string;
  unpaid?: boolean;
}

const PAID_LIKE = ['SUCCESS', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

export const invoiceDetailInclude = {
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } },
  branch: { select: { id: true, name: true, code: true } },
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly ledger: LedgerService,
    private readonly packages: PackagesService,
    private readonly memberships: MembershipsService,
    private readonly offers: OffersService,
    private readonly storage: StorageService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
    private readonly inventory: InventoryService,
  ) {}

  /** Gap-free per-branch numbering, e.g. INV-IND-000123. Serialised with an advisory lock. */
  async nextNumber(tx: DbOrTx, branchId: string) {
    const tenantId = RequestContext.requireTenantId();
    const prefix = String((await this.settings.get<string>(tenantId, 'INVOICE_PREFIX')) || 'INV').toUpperCase();
    await advisoryLock(tx, `invoice-seq:${branchId}:${prefix}`);
    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: { code: true } });
    if (!branch) throw AppError.notFound('Branch');
    const seq = await tx.invoiceSequence.upsert({
      where: { tenantId_branchId_prefix: { tenantId, branchId, prefix } },
      create: { tenantId, branchId, prefix, nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
    });
    return `${prefix}-${branch.code}-${String(seq.nextNumber - 1).padStart(6, '0')}`;
  }

  async list(q: InvoiceListQuery) {
    const where: Prisma.InvoiceWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = { in: q.status.split(',') as InvoiceStatus[] };
    if (q.unpaid) where.status = { in: ['ISSUED', 'PARTIALLY_PAID'] };
    if (q.search) {
      const s = q.search.trim();
      where.OR = [{ invoiceNumber: { contains: s.toUpperCase() } }, { customer: { name: { contains: s, mode: 'insensitive' } } }, { customer: { phone: { contains: s } } }];
    }
    if (q.from || q.to) {
      const tz = await this.settings.timezone(RequestContext.requireTenantId());
      where.createdAt = {
        ...(q.from ? { gte: DateTime.fromISO(q.from, { zone: tz }).startOf('day').toJSDate() } : {}),
        ...(q.to ? { lte: DateTime.fromISO(q.to, { zone: tz }).endOf('day').toJSDate() } : {}),
      };
    }
    const [items, total, sums] = await Promise.all([
      this.db.invoice.findMany({
        where,
        include: { customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } }, branch: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.invoice.count({ where }),
      this.db.invoice.aggregate({ where: { ...where, status: where.status ?? { not: 'CANCELLED' } }, _sum: { total: true, amountPaid: true, amountRefunded: true } }),
    ]);
    const result = paged(
      items.map((i) => ({ ...i, customer: i.customer ? maskContact(i.customer) : null, balanceDue: this.balance(i) })),
      total,
      q,
    );
    Object.assign(result.meta, { summary: { total: num(sums._sum.total), paid: num(sums._sum.amountPaid), refunded: num(sums._sum.amountRefunded) } });
    return result;
  }

  balance(i: { total: Prisma.Decimal | number; amountPaid: Prisma.Decimal | number; status: string }) {
    return i.status === 'CANCELLED' ? 0 : Math.max(0, round2(num(i.total) - num(i.amountPaid)));
  }

  async get(id: string, client: DbOrTx = this.db) {
    const inv = await client.invoice.findFirst({ where: { id }, include: invoiceDetailInclude });
    if (!inv) throw AppError.notFound('Invoice');
    RequestContext.assertBranch(inv.branchId);
    return inv;
  }

  async detail(id: string) {
    const inv = await this.get(id);
    const [coupon, offers] = await Promise.all([
      inv.couponId ? this.db.coupon.findFirst({ where: { id: inv.couponId }, select: { code: true } }) : null,
      this.db.offerRedemption.findMany({ where: { invoiceId: id } }),
    ]);
    const offerNames = offers.length ? await this.db.offer.findMany({ where: { id: { in: offers.map((o) => o.offerId) } }, select: { id: true, name: true } }) : [];
    return {
      ...inv,
      customer: inv.customer ? maskContact(inv.customer) : null,
      balanceDue: this.balance(inv),
      refundable: round2(inv.payments.filter((p) => PAID_LIKE.includes(p.status as never)).reduce((s, p) => s + num(p.amount) - num(p.refundedAmount), 0)),
      couponCode: coupon?.code ?? null,
      appliedOffers: offers.map((o) => ({ offerId: o.offerId, name: offerNames.find((n) => n.id === o.offerId)?.name ?? 'Offer', amount: num(o.discountAmount) })),
    };
  }

  /**
   * Recomputes paid/refunded totals and status from payments and refunds. The first time an
   * invoice becomes fully paid, purchased packages and memberships are activated and
   * `invoice.paid` is emitted. Must run inside the transaction that changed the payments.
   */
  async settle(tx: DbOrTx, invoiceId: string, at = new Date()) {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, include: { payments: true, refunds: true } });
    if (!inv) throw AppError.notFound('Invoice');
    if (inv.status === 'CANCELLED' || inv.status === 'DRAFT') return inv;
    const paid = round2(inv.payments.filter((p) => PAID_LIKE.includes(p.status as never)).reduce((s, p) => s + num(p.amount), 0));
    const refunded = round2(inv.refunds.filter((r) => r.status === 'SUCCESS').reduce((s, r) => s + num(r.amount), 0));
    const total = num(inv.total);
    let status: InvoiceStatus = paid >= total - 0.001 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
    if (paid > 0 && refunded >= paid - 0.001) status = 'REFUNDED';
    const becamePaid = status === 'PAID' && !inv.paidAt;
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { amountPaid: paid, amountRefunded: refunded, status, paidAt: becamePaid ? at : inv.paidAt },
    });
    if (becamePaid) {
      await this.packages.activateForInvoice(tx, invoiceId, at);
      await this.memberships.activateForInvoice(tx, invoiceId, at);
      if (inv.customerId) {
        await this.activity.record({ customerId: inv.customerId, branchId: inv.branchId, type: 'INVOICE_PAID', title: `Paid ${inv.invoiceNumber}`, refType: 'Invoice', refId: inv.id, meta: { total }, occurredAt: at }, tx);
      }
      await this.events.publish(DomainEvents.INVOICE_PAID, { invoiceId, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, branchId: inv.branchId, total, paidAt: at.toISOString() }, tx);
    }
    if (status === 'REFUNDED' && inv.status !== 'REFUNDED') {
      await this.packages.cancelForInvoice(tx, invoiceId, true);
      await this.memberships.cancelForInvoice(tx, invoiceId);
    }
    return updated;
  }

  /** Voids an unpaid (or fully refunded) invoice and unwinds everything checkout did. */
  async void(id: string, reason: string) {
    const inv = await this.get(id);
    if (inv.status === 'CANCELLED') throw AppError.invalidState('Invoice is already void.');
    const netPaid = round2(num(inv.amountPaid) - num(inv.amountRefunded));
    if (netPaid > 0) throw AppError.invalidState('Refund the payments on this invoice before voiding it.');
    const used = await this.db.customerPackage.findFirst({ where: { purchaseInvoiceId: id, items: { some: { usedQuantity: { gt: 0 } } } }, include: { package: { select: { name: true } } } });
    if (used) throw AppError.invalidState(`${used.package.name} from this invoice has already been used; reverse those sessions first.`);

    await this.db.$transaction(async (tx) => {
      const res = await tx.invoice.updateMany({ where: { id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      if (res.count === 0) throw AppError.invalidState('Invoice is already void.');
      await this.packages.cancelForInvoice(tx, id);
      await this.memberships.cancelForInvoice(tx, id);
      await this.memberships.releaseUsageForInvoice(tx, id);
      for (const item of inv.items) {
        const redemptionId = (item.meta as { redemptionId?: string } | null)?.redemptionId;
        if (redemptionId) await this.packages.reverse(redemptionId, `Invoice ${inv.invoiceNumber} voided`, tx);
      }
      if (inv.couponId) {
        await this.offers.release(tx, inv.couponId);
        await tx.couponRedemption.deleteMany({ where: { invoiceId: id } });
      }
      await tx.offerRedemption.deleteMany({ where: { invoiceId: id } });
      await tx.therapySession.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } });
      await tx.payment.updateMany({ where: { invoiceId: id, status: 'PENDING' }, data: { status: 'FAILED', notes: 'Invoice voided' } });
      await this.ledger.reverse(tx, 'INVOICE', id, `Invoice ${inv.invoiceNumber} voided: ${reason}`);
      await this.inventory.returnForInvoice(tx, inv);
      await this.events.publish(DomainEvents.INVOICE_VOIDED, { invoiceId: id, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, branchId: inv.branchId, reason }, tx);
    });
    await this.audit.log({ action: 'INVOICE_VOIDED', entityType: 'Invoice', entityId: id, oldValues: { status: inv.status, total: inv.total }, newValues: { reason } });
    this.realtime.toBranch(inv.branchId, 'invoices.changed', { id });
    return this.detail(id);
  }

  /** Renders the invoice PDF from current data and archives a copy in object storage. */
  async pdf(id: string) {
    const tenantId = RequestContext.requireTenantId();
    const inv = await this.get(id);
    const [tenant, branding, branch, tz] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId } }),
      this.db.tenantBranding.findFirst({ where: { tenantId } }),
      this.db.branch.findFirst({ where: { id: inv.branchId } }),
      this.settings.timezone(tenantId),
    ]);
    const buffer = await renderInvoicePdf({
      business: {
        name: branding?.appName || tenant!.name,
        legalName: tenant!.legalName,
        address: tenant!.address,
        phone: tenant!.phone,
        email: tenant!.email,
        taxId: tenant!.taxId,
        primaryColor: branding?.primaryColor,
        footer: branding?.invoiceFooter,
        poweredBy: branding?.poweredBy ?? true,
      },
      branch: { name: branch!.name, address: [branch!.address, branch!.city].filter(Boolean).join(', ') || null, phone: branch!.phone },
      invoice: {
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        issuedAt: formatInZone(inv.issuedAt ?? inv.createdAt, tz, 'dd LLL yyyy, hh:mm a'),
        currency: inv.currency,
        subtotal: num(inv.subtotal),
        discount: num(inv.discount),
        tax: num(inv.tax),
        rounding: num(inv.rounding),
        total: num(inv.total),
        amountPaid: num(inv.amountPaid),
        amountRefunded: num(inv.amountRefunded),
        notes: inv.notes,
      },
      customer: inv.customer ? { name: inv.customer.name, phone: inv.customer.phone, customerCode: inv.customer.customerCode } : null,
      items: inv.items.map((i) => {
        const meta = (i.meta ?? {}) as { coverageLabel?: string };
        return { description: i.description, quantity: i.quantity, unitPrice: num(i.unitPrice), discount: num(i.discount), taxRate: num(i.taxRate), tax: num(i.tax), total: num(i.total), note: meta.coverageLabel ? `Covered by ${meta.coverageLabel}` : undefined };
      }),
      payments: inv.payments
        .filter((p) => PAID_LIKE.includes(p.status as never))
        .map((p) => ({ method: p.method, amount: num(p.amount), paidAt: formatInZone(p.paidAt ?? p.createdAt, tz, 'dd LLL yyyy'), reference: p.reference })),
    });
    const key = `tenants/${tenantId}/invoices/${inv.invoiceNumber}.pdf`;
    await this.storage.put(key, buffer, 'application/pdf');
    if (inv.pdfKey !== key) await this.db.invoice.update({ where: { id }, data: { pdfKey: key } });
    return { buffer, filename: `${inv.invoiceNumber}.pdf` };
  }
}
