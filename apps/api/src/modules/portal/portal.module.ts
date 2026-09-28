import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FeatureFlagKey } from '@therapyos/types';
import {
  portalAppointmentsQuery,
  portalBookingSchema,
  portalBranchesQuery,
  portalCancelSchema,
  portalPaymentVerifySchema,
  portalProfileSchema,
  portalPurchaseSchema,
  portalRefreshSchema,
  portalRegisterSchema,
  portalSendOtpSchema,
  portalSlotsQuery,
  portalVerifyOtpSchema,
} from '@therapyos/validation';
import type { Response } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { CustomerOnly, Public, RequireFeature } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { num, round2 } from '../../common/utils/money';
import { isProd } from '../../config/env';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { OtpService } from '../auth/otp.service';
import { TokenService } from '../auth/token.service';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentsService } from '../appointments/appointments.service';
import { BillingModule } from '../billing/billing.module';
import { CartsService } from '../billing/carts.service';
import { InvoicesService } from '../billing/invoices.service';
import { PaymentsService } from '../billing/payments.service';
import { BookingModule, BookingService } from '../booking/booking.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomersService } from '../customers/customers.service';

type Input<T extends z.ZodTypeAny> = z.infer<T>;

/** Customers cannot cancel online inside this window; they are asked to call the centre instead. */
const CANCEL_CUTOFF_HOURS = 2;
const MAX_DAYS_AHEAD = 60;
const UPCOMING = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] as const;

/** Stored numbers are E.164 (+91…) but customers type local numbers; match every common form. */
export function phoneVariants(raw: string) {
  const digits = raw.replace(/[^\d+]/g, '');
  const plain = digits.replace(/^\+/, '');
  const local = plain.length === 12 && plain.startsWith('91') ? plain.slice(2) : plain.length === 11 && plain.startsWith('0') ? plain.slice(1) : plain;
  const e164 = digits.startsWith('+') ? digits : local.length === 10 ? `+91${local}` : `+${plain}`;
  const indian = local.length === 10 && e164 === `+91${local}` ? [`91${local}`, `0${local}`] : [];
  return { e164, all: [...new Set([digits, plain, local, e164, ...indian])] };
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return round2(6371 * 2 * Math.asin(Math.sqrt(h)));
}

// ---------------------------------------------------------------------------------------------- auth

@Injectable()
export class PortalAuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly customers: CustomersService,
    private readonly features: FeaturesService,
  ) {}

  private async tenant(slug: string) {
    const tenant = await this.db.tenant.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!tenant || tenant.status !== 'ACTIVE' || !(await this.features.isEnabled(tenant.id, FeatureFlagKey.CUSTOMER_APP))) throw AppError.notFound('Business');
    RequestContext.bindTenant(tenant.id);
    return tenant;
  }

  private scope(tenantId: string) {
    return `customer:${tenantId}`;
  }

  async sendOtp(input: Input<typeof portalSendOtpSchema>) {
    const t = await this.tenant(input.tenantSlug);
    return this.otp.send(phoneVariants(input.phone).e164, this.scope(t.id));
  }

  async verifyOtp(input: Input<typeof portalVerifyOtpSchema>) {
    const t = await this.tenant(input.tenantSlug);
    const { e164, all } = phoneVariants(input.phone);
    await this.otp.verify(e164, input.code, this.scope(t.id));
    const customer = await this.db.customer.findFirst({ where: { phone: { in: all } }, orderBy: { createdAt: 'asc' } });
    if (!customer) return { needsProfile: true as const, signupToken: await this.tokens.signupToken(t.id, e164) };
    if (customer.status === 'BLOCKED') throw AppError.forbidden('This account cannot sign in. Please contact the centre.');
    return { tokens: await this.tokens.issueForCustomer(customer), customer: { id: customer.id, name: customer.name, phone: customer.phone } };
  }

  async register(input: Input<typeof portalRegisterSchema>) {
    const { tenantId, phone } = await this.tokens.verifySignupToken(input.signupToken);
    RequestContext.bindTenant(tenantId);
    if (input.branchId && !(await this.db.branch.findFirst({ where: { id: input.branchId, status: 'ACTIVE' } }))) throw AppError.notFound('Branch');
    const customer = await this.customers.findOrCreate({ name: input.name, phone, email: input.email, branchId: input.branchId, source: 'CUSTOMER_APP' });
    return { tokens: await this.tokens.issueForCustomer(customer), customer: { id: customer.id, name: customer.name, phone: customer.phone } };
  }

  refresh(raw: string) {
    return this.tokens.rotate(raw, 'customer').then(({ accessToken, refreshToken, expiresIn }) => ({ accessToken, refreshToken, expiresIn }));
  }

  async logout(raw: string) {
    await this.tokens.revoke(raw);
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------------------------- customer

@Injectable()
export class PortalService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly booking: BookingService,
    private readonly appointments: AppointmentsService,
    private readonly carts: CartsService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
  ) {}

  private async tenant() {
    const tenantId = RequestContext.requireTenantId();
    const [tenant, tz] = await Promise.all([
      this.db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, name: true, currency: true, phone: true, logoUrl: true } }),
      this.settings.timezone(tenantId),
    ]);
    return { ...tenant, tz };
  }

  async me() {
    const id = RequestContext.requireCustomerId();
    const [c, t] = await Promise.all([this.db.customer.findFirstOrThrow({ where: { id }, include: { metrics: true } }), this.tenant()]);
    const branding = await this.db.tenantBranding.findUnique({ where: { tenantId: c.tenantId } });
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      gender: c.gender,
      dob: c.dob ? DateTime.fromJSDate(c.dob, { zone: 'UTC' }).toISODate() : null,
      customerCode: c.customerCode,
      marketingOptIn: c.marketingOptIn,
      whatsappOptIn: c.whatsappOptIn,
      memberSince: c.createdAt,
      visits: c.metrics?.visitCount ?? 0,
      lastVisitAt: c.metrics?.lastVisitAt ?? null,
      business: { slug: t.slug, name: branding?.appName || t.name, logoUrl: branding?.logoUrl ?? t.logoUrl, primaryColor: branding?.primaryColor ?? null, phone: t.phone, currency: t.currency, timezone: t.tz },
    };
  }

  async updateMe(input: Input<typeof portalProfileSchema>) {
    const id = RequestContext.requireCustomerId();
    await this.db.customer.update({
      where: { id },
      data: {
        name: input.name,
        email: input.email === undefined ? undefined : input.email,
        gender: input.gender === undefined ? undefined : input.gender,
        dob: input.dob === undefined ? undefined : input.dob ? new Date(`${input.dob}T00:00:00.000Z`) : null,
        marketingOptIn: input.marketingOptIn,
        whatsappOptIn: input.whatsappOptIn,
      },
    });
    return this.me();
  }

  async home() {
    const [me, upcoming, packages, memberships, offers] = await Promise.all([this.me(), this.listAppointments('upcoming'), this.packages(), this.memberships(), this.offers()]);
    const activePackages = packages.filter((p) => p.status === 'ACTIVE');
    const due = await this.db.invoice.aggregate({
      where: { customerId: me.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      _sum: { total: true, amountPaid: true },
    });
    return {
      customer: me,
      nextAppointment: upcoming[0] ?? null,
      upcomingCount: upcoming.length,
      sessionsLeft: activePackages.reduce((s, p) => s + p.remaining, 0),
      activePackages: activePackages.length,
      membership: memberships.find((m) => m.status === 'ACTIVE') ?? null,
      offers: offers.offers.length + offers.coupons.length,
      amountDue: round2(num(due._sum.total) - num(due._sum.amountPaid)),
    };
  }

  async branches(q: Input<typeof portalBranchesQuery>) {
    const rows = await this.db.branch.findMany({
      where: { status: 'ACTIVE', publicBookingEnabled: true },
      select: { id: true, name: true, code: true, address: true, city: true, phone: true, latitude: true, longitude: true, openingTime: true, closingTime: true },
      orderBy: { name: 'asc' },
    });
    const list = rows.map((b) => {
      const lat = b.latitude === null ? null : num(b.latitude);
      const lng = b.longitude === null ? null : num(b.longitude);
      return { ...b, latitude: lat, longitude: lng, distanceKm: q.lat !== undefined && q.lng !== undefined && lat !== null && lng !== null ? distanceKm(q.lat, q.lng, lat, lng) : null };
    });
    return list.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.name.localeCompare(b.name));
  }

  async catalog() {
    const t = await this.tenant();
    const info = await this.booking.info(t.slug);
    return { timezone: info.timezone, today: info.today, maxDate: info.maxDate, services: info.services };
  }

  async slots(q: Input<typeof portalSlotsQuery>) {
    const t = await this.tenant();
    return this.booking.slots(t.slug, q);
  }

  async book(input: Input<typeof portalBookingSchema>) {
    const customerId = RequestContext.requireCustomerId();
    const t = await this.tenant();
    const branch = await this.db.branch.findFirst({ where: { id: input.branchId, status: 'ACTIVE', publicBookingEnabled: true } });
    if (!branch) throw AppError.notFound('Branch');
    const day = DateTime.fromISO(input.date, { zone: t.tz });
    if (day > DateTime.now().setZone(t.tz).plus({ days: MAX_DAYS_AHEAD })) throw AppError.validation(`Bookings open ${MAX_DAYS_AHEAD} days ahead.`);
    const appt = await this.appointments.create({
      branchId: input.branchId,
      customerId,
      serviceId: input.serviceId,
      therapistId: input.therapistId,
      date: input.date,
      startTime: input.startTime,
      source: 'CUSTOMER_APP',
      notes: input.notes ? `App booking: ${input.notes}` : 'App booking',
    });
    return this.appointment(appt.id);
  }

  private present(a: { id: string; status: string; startTime: Date; endTime: Date; notes: string | null; cancelReason: string | null; service: { id: string; name: string }; therapist: { id: string; name: string } | null; branch: { id: string; name: string; address: string | null; phone: string | null } }, tz: string) {
    const start = DateTime.fromJSDate(a.startTime).setZone(tz);
    const canCancel = ['BOOKED', 'CONFIRMED'].includes(a.status) && start.diffNow('hours').hours >= CANCEL_CUTOFF_HOURS;
    return {
      id: a.id,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
      date: start.toISODate(),
      time: start.toFormat('HH:mm'),
      durationMinutes: Math.round((a.endTime.getTime() - a.startTime.getTime()) / 60_000),
      service: a.service,
      therapist: a.therapist,
      branch: a.branch,
      notes: a.notes,
      cancelReason: a.cancelReason,
      canCancel,
    };
  }

  private readonly apptInclude = {
    service: { select: { id: true, name: true } },
    therapist: { select: { id: true, name: true } },
    branch: { select: { id: true, name: true, address: true, phone: true } },
  } as const;

  async listAppointments(scope: 'upcoming' | 'past') {
    const customerId = RequestContext.requireCustomerId();
    const { tz } = await this.tenant();
    const now = new Date();
    const rows = await this.db.appointment.findMany({
      where:
        scope === 'upcoming'
          ? { customerId, status: { in: [...UPCOMING] }, endTime: { gte: now } }
          : { customerId, OR: [{ status: { notIn: [...UPCOMING] } }, { endTime: { lt: now } }] },
      include: this.apptInclude,
      orderBy: { startTime: scope === 'upcoming' ? 'asc' : 'desc' },
      take: 50,
    });
    return rows.map((a) => this.present(a, tz));
  }

  private async own(id: string) {
    const a = await this.db.appointment.findFirst({ where: { id, customerId: RequestContext.requireCustomerId() }, include: this.apptInclude });
    if (!a) throw AppError.notFound('Appointment');
    return a;
  }

  async appointment(id: string) {
    const [a, { tz }] = await Promise.all([this.own(id), this.tenant()]);
    return this.present(a, tz);
  }

  async cancel(id: string, reason?: string) {
    const [a, { tz }] = await Promise.all([this.own(id), this.tenant()]);
    if (!this.present(a, tz).canCancel) {
      throw AppError.invalidState(`Appointments can be cancelled in the app up to ${CANCEL_CUTOFF_HOURS} hours before the start. Please call ${a.branch.name}${a.branch.phone ? ` on ${a.branch.phone}` : ''}.`);
    }
    await this.appointments.cancel(id, reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer in the app');
    return this.appointment(id);
  }

  async packages() {
    const rows = await this.db.customerPackage.findMany({
      where: { customerId: RequestContext.requireCustomerId(), status: { not: 'CANCELLED' } },
      include: { package: { select: { name: true } }, items: { include: { service: { select: { id: true, name: true } } } } },
      orderBy: [{ status: 'asc' }, { expiresAt: 'asc' }],
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.package.name,
      status: p.status,
      purchasedAt: p.purchasedAt,
      expiresAt: p.expiresAt,
      daysLeft: Math.max(0, Math.ceil((p.expiresAt.getTime() - Date.now()) / 86_400_000)),
      remaining: p.items.reduce((s, i) => s + i.totalQuantity - i.usedQuantity, 0),
      total: p.items.reduce((s, i) => s + i.totalQuantity, 0),
      items: p.items.map((i) => ({ serviceId: i.serviceId, service: i.service.name, total: i.totalQuantity, used: i.usedQuantity, remaining: i.totalQuantity - i.usedQuantity })),
      invoiceId: p.purchaseInvoiceId,
    }));
  }

  async memberships() {
    const rows = await this.db.customerMembership.findMany({
      where: { customerId: RequestContext.requireCustomerId(), status: { not: 'CANCELLED' } },
      include: { plan: { include: { benefits: true } } },
      orderBy: [{ status: 'asc' }, { expiresAt: 'desc' }],
    });
    const serviceIds = [...new Set(rows.flatMap((m) => m.plan.benefits.map((b) => b.serviceId).filter((x): x is string => !!x)))];
    const services = new Map((await this.db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return rows.map((m) => ({
      id: m.id,
      plan: m.plan.name,
      status: m.status,
      startedAt: m.startedAt,
      expiresAt: m.expiresAt,
      autoRenew: m.autoRenew,
      daysLeft: Math.max(0, Math.ceil((m.expiresAt.getTime() - Date.now()) / 86_400_000)),
      benefits: m.plan.benefits.map((b) => this.benefitText(b, services)),
      invoiceId: m.purchaseInvoiceId,
    }));
  }

  private benefitText(b: { type: string; value: unknown; quantity: number | null; serviceId: string | null }, services: Map<string, string>) {
    const target = b.serviceId ? services.get(b.serviceId) ?? 'selected services' : 'all services';
    switch (b.type) {
      case 'SERVICE_DISCOUNT_PERCENT':
        return `${num(b.value as number)}% off ${target}`;
      case 'PRODUCT_DISCOUNT_PERCENT':
        return `${num(b.value as number)}% off products`;
      case 'INCLUDED_SESSIONS':
        return `${b.quantity ?? 1} included ${target} session${(b.quantity ?? 1) > 1 ? 's' : ''}`;
      default:
        return 'Priority booking';
    }
  }

  async store() {
    const [packages, plans] = await Promise.all([
      this.db.package.findMany({ where: { status: 'ACTIVE' }, include: { items: { include: { service: { select: { name: true, basePrice: true } } } } }, orderBy: { price: 'asc' } }),
      this.db.membershipPlan.findMany({ where: { status: 'ACTIVE' }, include: { benefits: true }, orderBy: { price: 'asc' } }),
    ]);
    const serviceIds = [...new Set(plans.flatMap((p) => p.benefits.map((b) => b.serviceId).filter((x): x is string => !!x)))];
    const services = new Map((await this.db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return {
      packages: packages.map((p) => {
        const worth = p.items.reduce((s, i) => s + num(i.service.basePrice) * i.quantity, 0);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          price: num(p.price),
          validityDays: p.validityDays,
          worth: round2(worth),
          savings: round2(Math.max(0, worth - num(p.price))),
          items: p.items.map((i) => ({ service: i.service.name, quantity: i.quantity })),
        };
      }),
      memberships: plans.map((p) => ({ id: p.id, name: p.name, description: p.description, price: num(p.price), billingInterval: p.billingInterval, durationDays: p.durationDays, benefits: p.benefits.map((b) => this.benefitText(b, services)) })),
    };
  }

  /** Issues an unpaid invoice for a package or membership and opens a gateway order for it. */
  async purchase(input: Input<typeof portalPurchaseSchema>) {
    const customerId = RequestContext.requireCustomerId();
    const branch = await this.db.branch.findFirst({ where: { id: input.branchId, status: 'ACTIVE' } });
    if (!branch) throw AppError.notFound('Branch');
    const invoice = await this.carts.sellDirect({ branchId: input.branchId, customerId, itemType: input.itemType, itemId: input.itemId });
    return { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, order: await this.payments.createOrder(invoice.id) };
  }

  async listInvoices() {
    const rows = await this.db.invoice.findMany({
      where: { customerId: RequestContext.requireCustomerId(), status: { not: 'DRAFT' } },
      include: { branch: { select: { name: true } }, items: { select: { description: true, quantity: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 50,
    });
    return rows.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      status: i.status,
      issuedAt: i.issuedAt,
      branch: i.branch.name,
      total: num(i.total),
      amountPaid: num(i.amountPaid),
      balance: ['ISSUED', 'PARTIALLY_PAID'].includes(i.status) ? round2(num(i.total) - num(i.amountPaid)) : 0,
      currency: i.currency,
      summary: i.items.map((x) => (x.quantity > 1 ? `${x.description} × ${x.quantity}` : x.description)).join(', '),
    }));
  }

  private async ownInvoice(id: string) {
    const inv = await this.db.invoice.findFirst({ where: { id, customerId: RequestContext.requireCustomerId(), status: { not: 'DRAFT' } }, select: { id: true } });
    if (!inv) throw AppError.notFound('Invoice');
    return inv;
  }

  async payInvoice(id: string) {
    await this.ownInvoice(id);
    return this.payments.createOrder(id);
  }

  async invoicePdf(id: string) {
    await this.ownInvoice(id);
    return this.invoices.pdf(id);
  }

  private async ownPayment(where: { id?: string; providerOrderId?: string }) {
    const p = await this.db.payment.findFirst({ where: { ...where, customerId: RequestContext.requireCustomerId() }, select: { id: true } });
    if (!p) throw AppError.notFound('Payment');
    return p;
  }

  async verifyPayment(input: Input<typeof portalPaymentVerifySchema>) {
    await this.ownPayment({ providerOrderId: input.razorpay_order_id });
    const inv = await this.payments.verify(input);
    return { invoiceId: inv.id, status: inv.status };
  }

  async mockComplete(paymentId: string) {
    if (isProd()) throw AppError.forbidden('Mock payments are disabled in production.');
    await this.ownPayment({ id: paymentId });
    const inv = await this.payments.mockComplete(paymentId);
    return { invoiceId: inv.id, status: inv.status };
  }

  async offers() {
    const { tz } = await this.tenant();
    const today = new Date(`${DateTime.now().setZone(tz).toISODate()}T00:00:00.000Z`);
    const [offers, coupons] = await Promise.all([
      this.db.offer.findMany({ where: { status: 'ACTIVE', startDate: { lte: today }, endDate: { gte: today } }, orderBy: { endDate: 'asc' } }),
      this.db.coupon.findMany({ where: { status: 'ACTIVE', campaignId: null, startDate: { lte: today }, endDate: { gte: today } }, orderBy: { endDate: 'asc' } }),
    ]);
    return {
      offers: offers.map((o) => ({ id: o.id, name: o.name, description: o.description, type: o.offerType, value: num(o.value), appliesTo: o.appliesTo, minOrder: o.minOrder === null ? null : num(o.minOrder), endDate: DateTime.fromJSDate(o.endDate, { zone: 'UTC' }).toISODate(), autoApply: o.autoApply })),
      coupons: coupons
        .filter((c) => c.usageLimit === null || c.usedCount < c.usageLimit)
        .map((c) => ({ code: c.code, description: c.description, discountType: c.discountType, discountValue: num(c.discountValue), minimumOrder: c.minimumOrder === null ? null : num(c.minimumOrder), maximumDiscount: c.maximumDiscount === null ? null : num(c.maximumDiscount), endDate: DateTime.fromJSDate(c.endDate, { zone: 'UTC' }).toISODate() })),
    };
  }
}

// ---------------------------------------------------------------------------------------------- controllers

@ApiTags('Customer app')
@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly auth: PortalAuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('send-otp')
  sendOtp(@Body(Zod(portalSendOtpSchema)) body: Input<typeof portalSendOtpSchema>) {
    return this.auth.sendOtp(body);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-otp')
  verifyOtp(@Body(Zod(portalVerifyOtpSchema)) body: Input<typeof portalVerifyOtpSchema>) {
    return this.auth.verifyOtp(body);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body(Zod(portalRegisterSchema)) body: Input<typeof portalRegisterSchema>) {
    return this.auth.register(body);
  }

  @Public()
  @Post('refresh')
  refresh(@Body(Zod(portalRefreshSchema)) body: Input<typeof portalRefreshSchema>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  logout(@Body(Zod(portalRefreshSchema)) body: Input<typeof portalRefreshSchema>) {
    return this.auth.logout(body.refreshToken);
  }
}

@ApiTags('Customer app')
@ApiBearerAuth()
@Controller('portal')
@CustomerOnly()
@RequireFeature(FeatureFlagKey.CUSTOMER_APP)
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  me() {
    return this.portal.me();
  }

  @Patch('me')
  updateMe(@Body(Zod(portalProfileSchema)) body: Input<typeof portalProfileSchema>) {
    return this.portal.updateMe(body);
  }

  @Get('home')
  home() {
    return this.portal.home();
  }

  @Get('branches')
  branches(@Query(Zod(portalBranchesQuery)) q: Input<typeof portalBranchesQuery>) {
    return this.portal.branches(q);
  }

  @Get('catalog')
  catalog() {
    return this.portal.catalog();
  }

  @Get('slots')
  slots(@Query(Zod(portalSlotsQuery)) q: Input<typeof portalSlotsQuery>) {
    return this.portal.slots(q);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('appointments')
  book(@Body(Zod(portalBookingSchema)) body: Input<typeof portalBookingSchema>) {
    return this.portal.book(body);
  }

  @Get('appointments')
  appointments(@Query(Zod(portalAppointmentsQuery)) q: Input<typeof portalAppointmentsQuery>) {
    return this.portal.listAppointments(q.scope);
  }

  @Get('appointments/:id')
  appointment(@Param('id') id: string) {
    return this.portal.appointment(id);
  }

  @Post('appointments/:id/cancel')
  cancel(@Param('id') id: string, @Body(Zod(portalCancelSchema)) body: Input<typeof portalCancelSchema>) {
    return this.portal.cancel(id, body.reason);
  }

  @Get('packages')
  packages() {
    return this.portal.packages();
  }

  @Get('memberships')
  memberships() {
    return this.portal.memberships();
  }

  @Get('store')
  store() {
    return this.portal.store();
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('purchase')
  purchase(@Body(Zod(portalPurchaseSchema)) body: Input<typeof portalPurchaseSchema>) {
    return this.portal.purchase(body);
  }

  @Get('invoices')
  invoices() {
    return this.portal.listInvoices();
  }

  @Post('invoices/:id/pay')
  pay(@Param('id') id: string) {
    return this.portal.payInvoice(id);
  }

  @Get('invoices/:id/pdf')
  async pdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { buffer, filename } = await this.portal.invoicePdf(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'private, no-store' });
    return new StreamableFile(buffer);
  }

  @Post('payments/verify')
  verify(@Body(Zod(portalPaymentVerifySchema)) body: Input<typeof portalPaymentVerifySchema>) {
    return this.portal.verifyPayment(body);
  }

  @Post('payments/:id/mock-complete')
  mockComplete(@Param('id') id: string) {
    return this.portal.mockComplete(id);
  }

  @Get('offers')
  offers() {
    return this.portal.offers();
  }
}

@Module({
  imports: [AppointmentsModule, BillingModule, BookingModule, CustomersModule],
  controllers: [PortalAuthController, PortalController],
  providers: [PortalAuthService, PortalService],
})
export class PortalModule {}
