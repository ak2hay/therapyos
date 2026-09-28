import { Injectable } from '@nestjs/common';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { formatInZone } from '../../common/utils/dates';
import { env } from '../../config/env';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { EventMeta, OnDomainEvent } from '../../jobs/event-handlers';
import { NotificationsService } from './notifications.service';

/** Transactional messages about something that happened hours ago are confusing; drop them. */
const STALE_MS = 6 * 3_600_000;
const isStale = (meta: EventMeta) => Date.now() - new Date(meta.createdAt).getTime() > STALE_MS;

export function formatMoney(amount: number, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Maps domain events to customer messages and staff alerts. Every send is deduplicated by reference. */
@Injectable()
export class NotificationHandlers {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly features: FeaturesService,
  ) {}

  private async appointmentVars(appointmentId: string) {
    const tenantId = RequestContext.requireTenantId();
    const a = await this.db.appointment.findFirst({
      where: { id: appointmentId },
      include: { service: { select: { name: true } }, therapist: { select: { name: true } }, branch: { select: { timezone: true } } },
    });
    if (!a) return null;
    const tz = a.branch.timezone ?? (await this.settings.timezone(tenantId));
    return {
      appointment: a,
      vars: { service_name: a.service.name, therapist_name: a.therapist?.name ?? 'our team', appointment_time: formatInZone(a.startTime, tz, 'EEE, dd LLL, h:mm a') },
    };
  }

  @OnDomainEvent('appointment.created')
  async appointmentBooked(p: Record<string, any>, meta: EventMeta) {
    if (isStale(meta) || p.source === 'WALK_IN') return;
    const r = await this.appointmentVars(p.appointmentId);
    if (!r || r.appointment.startTime < new Date()) return;
    return this.notifications.notifyCustomer('APPOINTMENT_BOOKED', p.customerId, r.vars, { refType: 'Appointment', refId: p.appointmentId, branchId: p.branchId });
  }

  @OnDomainEvent('appointment.cancelled')
  async appointmentCancelled(p: Record<string, any>, meta: EventMeta) {
    if (isStale(meta)) return;
    const r = await this.appointmentVars(p.appointmentId);
    if (!r || r.appointment.startTime < new Date()) return;
    return this.notifications.notifyCustomer('APPOINTMENT_CANCELLED', p.customerId, r.vars, { refType: 'Appointment', refId: p.appointmentId, branchId: p.branchId });
  }

  @OnDomainEvent('appointment.reminder_due')
  async appointmentReminder(p: Record<string, any>) {
    const r = await this.appointmentVars(p.appointmentId);
    if (!r || r.appointment.startTime < new Date() || !['BOOKED', 'CONFIRMED'].includes(r.appointment.status)) return;
    return this.notifications.notifyCustomer('APPOINTMENT_REMINDER', r.appointment.customerId, r.vars, { refType: 'Appointment', refId: p.appointmentId, branchId: r.appointment.branchId });
  }

  @OnDomainEvent('feedback.requested')
  async feedbackRequested(p: Record<string, any>, meta: EventMeta) {
    if (isStale(meta) || !p.customerId) return;
    // Event payloads are redacted (tokens never sit in the outbox), so read the token from its row.
    const request = await this.db.feedbackRequest.findFirst({ where: { id: p.feedbackRequestId }, select: { token: true, usedAt: true, expiresAt: true } });
    if (!request || request.usedAt || request.expiresAt < new Date()) return;
    const session = p.sessionId ? await this.db.therapySession.findFirst({ where: { id: p.sessionId }, select: { service: { select: { name: true } } } }) : null;
    return this.notifications.notifyCustomer(
      'FEEDBACK_REQUEST',
      p.customerId,
      { service_name: session?.service.name ?? 'visit', feedback_link: `${env().APP_URL}/f/${request.token}` },
      { refType: 'FeedbackRequest', refId: p.feedbackRequestId, branchId: p.branchId },
    );
  }

  /** The thank-you message only goes out when no feedback request (which already thanks them) will. */
  @OnDomainEvent('session.completed')
  async sessionCompleted(p: Record<string, any>, meta: EventMeta) {
    if (isStale(meta) || !p.customerId) return;
    const tenantId = RequestContext.requireTenantId();
    if (await this.settings.get<boolean>(tenantId, 'FEEDBACK_REQUEST_ENABLED')) return;
    const session = await this.db.therapySession.findFirst({ where: { id: p.sessionId }, select: { service: { select: { name: true } } } });
    return this.notifications.notifyCustomer('SESSION_COMPLETED', p.customerId, { service_name: session?.service.name ?? '' }, { refType: 'Session', refId: p.sessionId, branchId: p.branchId });
  }

  @OnDomainEvent('payment.received')
  async paymentReceived(p: Record<string, any>, meta: EventMeta) {
    if (isStale(meta) || !p.customerId) return;
    const tenantId = RequestContext.requireTenantId();
    const [invoice, currency] = await Promise.all([
      this.db.invoice.findFirst({ where: { id: p.invoiceId }, select: { invoiceNumber: true } }),
      this.settings.get<string>(tenantId, 'CURRENCY'),
    ]);
    return this.notifications.notifyCustomer(
      'PAYMENT_RECEIVED',
      p.customerId,
      { amount: formatMoney(Number(p.amount ?? 0), currency), invoice_number: invoice?.invoiceNumber ?? '' },
      { refType: 'Payment', refId: p.paymentId, branchId: p.branchId },
    );
  }

  @OnDomainEvent('package.expiring')
  async packageExpiring(p: Record<string, any>) {
    return this.notifications.notifyCustomer(
      'PACKAGE_EXPIRING',
      p.customerId,
      { package_name: p.packageName, expiry_date: p.expiryDate, remaining_sessions: p.remainingSessions },
      { refType: 'CustomerPackage', refId: p.customerPackageId, branchId: p.branchId, dedupeKey: `PACKAGE_EXPIRING:${p.customerPackageId}:${p.expiryDate}` },
    );
  }

  @OnDomainEvent('membership.expiring')
  async membershipExpiring(p: Record<string, any>) {
    return this.notifications.notifyCustomer(
      'MEMBERSHIP_EXPIRING',
      p.customerId,
      { plan_name: p.planName, expiry_date: p.expiryDate },
      { refType: 'CustomerMembership', refId: p.customerMembershipId, branchId: p.branchId, dedupeKey: `MEMBERSHIP_EXPIRING:${p.customerMembershipId}:${p.expiryDate}` },
    );
  }

  @OnDomainEvent('customer.birthday')
  async birthday(p: Record<string, any>) {
    return this.notifications.notifyCustomer('BIRTHDAY', p.customerId, {}, { refType: 'Customer', refId: p.customerId, branchId: p.branchId, dedupeKey: `BIRTHDAY:${p.customerId}:${p.year}` });
  }

  @OnDomainEvent('customer.inactive')
  async winBack(p: Record<string, any>) {
    const tenantId = RequestContext.requireTenantId();
    if (!(await this.features.isEnabled(tenantId, FeatureFlagKey.RETENTION_AUTOMATION))) return;
    return this.notifications.notifyCustomer(
      'WIN_BACK',
      p.customerId,
      { days_since_visit: p.daysSinceVisit },
      { refType: 'Customer', refId: p.customerId, branchId: p.branchId, dedupeKey: `WIN_BACK:${p.customerId}:${p.lastVisitAt ?? 'never'}` },
    );
  }

  @OnDomainEvent('inventory.stock_low')
  async stockLow(p: Record<string, any>) {
    const [product, branch] = await Promise.all([
      this.db.product.findFirst({ where: { id: p.productId }, select: { name: true, unit: true } }),
      this.db.branch.findFirst({ where: { id: p.branchId }, select: { name: true } }),
    ]);
    if (!product) return;
    const qty = `${Number(p.quantity)} ${product.unit ?? ''}`.trim();
    return this.notifications.notifyStaff({
      permission: PERMISSIONS.INVENTORY_PURCHASE,
      branchId: p.branchId,
      type: 'STOCK_LOW',
      title: `Low stock: ${product.name}`,
      body: `${qty} left at ${branch?.name ?? 'branch'} (reorder level ${Number(p.reorderLevel)}).`,
      link: `/inventory?lowStock=true&branchId=${p.branchId}`,
      dedupeKey: `STOCK_LOW:${p.branchId}:${p.productId}:${new Date().toISOString().slice(0, 10)}`,
      email: { event: 'LOW_STOCK', vars: { product_name: product.name, quantity: qty, reorder_level: Number(p.reorderLevel) } },
    });
  }

  /** Unhappy customers are escalated to managers the moment they rate, while recovery is still possible. */
  @OnDomainEvent('feedback.received')
  async lowRating(p: Record<string, any>) {
    if (Number(p.rating) > 2) return;
    const customer = p.customerId ? await this.db.customer.findFirst({ where: { id: p.customerId }, select: { name: true } }) : null;
    return this.notifications.notifyStaff({
      permission: PERMISSIONS.FEEDBACK_MANAGE,
      branchId: p.branchId,
      type: 'LOW_RATING',
      title: `${p.rating}★ feedback${customer ? ` from ${customer.name}` : ''}`,
      body: p.comment ? String(p.comment).slice(0, 180) : 'No comment left. Consider calling the customer.',
      link: `/feedback?maxRating=2&highlight=${p.feedbackId}`,
      dedupeKey: `LOW_RATING:${p.feedbackId}`,
    });
  }
}
