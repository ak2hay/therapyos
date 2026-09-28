import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { publicBookingSchema, publicSlotsQuery } from '@therapyos/validation';
import { DateTime } from 'luxon';
import QRCode from 'qrcode';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { Public, RequirePermissions } from '../../common/decorators';
import { AppError } from '../../common/errors/app-error';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { num } from '../../common/utils/money';
import { env } from '../../config/env';
import { FeaturesService } from '../../core/features.service';
import { SettingsService } from '../../core/settings.service';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AppointmentsService } from '../appointments/appointments.service';
import { AvailabilityService } from '../appointments/availability.service';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomersService } from '../customers/customers.service';

const bookingBody = publicBookingSchema.extend({ branchId: z.string().min(1) });
/** How far ahead guests may book online. */
const MAX_DAYS_AHEAD = 60;

@Injectable()
export class BookingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
    private readonly customers: CustomersService,
    private readonly settings: SettingsService,
    private readonly features: FeaturesService,
  ) {}

  /** Resolves the tenant by slug and binds it to the (public, tenant-less) request context. */
  private async bind(slug: string) {
    const tenant = await this.db.tenant.findUnique({ where: { slug }, select: { id: true, name: true, logoUrl: true, slug: true, status: true, phone: true, currency: true } });
    if (!tenant || tenant.status !== 'ACTIVE') throw AppError.notFound('Business');
    RequestContext.bindTenant(tenant.id);
    return tenant;
  }

  private async branch(branchId: string) {
    const b = await this.db.branch.findFirst({ where: { id: branchId, status: 'ACTIVE', publicBookingEnabled: true } });
    if (!b) throw AppError.notFound('Branch');
    return b;
  }

  async info(slug: string) {
    const tenant = await this.bind(slug);
    const [branches, services, branding, whiteLabel, tz] = await Promise.all([
      this.db.branch.findMany({
        where: { status: 'ACTIVE', publicBookingEnabled: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, address: true, city: true, phone: true, openingTime: true, closingTime: true },
      }),
      this.db.service.findMany({
        where: { status: 'ACTIVE', therapistServices: { some: { therapist: { status: 'ACTIVE' } } } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          durationMinutes: true,
          basePrice: true,
          category: { select: { id: true, name: true } },
          branchServices: { select: { branchId: true, price: true, durationMinutes: true, isActive: true } },
        },
      }),
      this.db.tenantBranding.findUnique({ where: { tenantId: tenant.id } }),
      this.features.isEnabled(tenant.id, FeatureFlagKey.WHITE_LABEL),
      this.settings.timezone(tenant.id),
    ]);
    const b = whiteLabel ? branding : null;
    return {
      business: { name: b?.appName ?? tenant.name, slug: tenant.slug, logoUrl: b?.logoUrl ?? tenant.logoUrl, phone: tenant.phone, currency: tenant.currency, primaryColor: b?.primaryColor ?? null, poweredBy: b ? b.poweredBy : true },
      timezone: tz,
      today: DateTime.now().setZone(tz).toISODate(),
      maxDate: DateTime.now().setZone(tz).plus({ days: MAX_DAYS_AHEAD }).toISODate(),
      branches,
      services: services.map(({ branchServices, basePrice, ...s }) => ({
        ...s,
        price: num(basePrice),
        branches: branches
          .filter((br) => !branchServices.some((o) => o.branchId === br.id && !o.isActive))
          .map((br) => {
            const o = branchServices.find((x) => x.branchId === br.id);
            return { branchId: br.id, price: o?.price != null ? num(o.price) : num(basePrice), durationMinutes: o?.durationMinutes ?? s.durationMinutes };
          }),
      })),
    };
  }

  async slots(slug: string, q: z.infer<typeof publicSlotsQuery>) {
    await this.bind(slug);
    await this.branch(q.branchId);
    const tz = await this.settings.timezone(RequestContext.requireTenantId());
    const today = DateTime.now().setZone(tz).startOf('day');
    const day = DateTime.fromISO(q.date, { zone: tz });
    if (!day.isValid || day < today || day > today.plus({ days: MAX_DAYS_AHEAD })) throw AppError.validation(`Pick a date within the next ${MAX_DAYS_AHEAD} days.`);
    const r = await this.availability.slots({ branchId: q.branchId, serviceId: q.serviceId, date: q.date, therapistId: q.therapistId });
    return {
      date: r.date,
      durationMinutes: r.durationMinutes,
      price: r.price,
      therapists: r.therapists.map((t) => ({ id: t.id, name: t.name })),
      slots: r.slots.map((s) => ({ time: s.time, therapistIds: s.therapistIds })),
    };
  }

  async book(slug: string, input: z.infer<typeof bookingBody>) {
    const tenant = await this.bind(slug);
    const branch = await this.branch(input.branchId);
    const tz = await this.settings.timezone(tenant.id);
    const day = DateTime.fromISO(input.date, { zone: tz });
    if (day > DateTime.now().setZone(tz).plus({ days: MAX_DAYS_AHEAD })) throw AppError.validation(`Bookings open ${MAX_DAYS_AHEAD} days ahead.`);
    const customer = await this.customers.findOrCreate({ name: input.name, phone: input.phone, email: input.email, branchId: branch.id, source: 'WEBSITE' });
    const appt = await this.appointments.create({
      branchId: branch.id,
      customerId: customer.id,
      serviceId: input.serviceId,
      therapistId: input.therapistId,
      date: input.date,
      startTime: input.startTime,
      source: 'WEBSITE',
      notes: input.notes ? `Online booking: ${input.notes}` : 'Online booking',
    });
    return {
      appointmentId: appt.id,
      date: input.date,
      startTime: input.startTime,
      service: appt.service?.name,
      therapist: appt.therapist?.name ?? null,
      branch: { name: branch.name, address: branch.address, phone: branch.phone },
      customerName: customer.name,
    };
  }

  async branchQr(branchId: string) {
    RequestContext.assertBranch(branchId);
    const tenantId = RequestContext.requireTenantId();
    const [branch, tenant] = await Promise.all([this.db.branch.findFirst({ where: { id: branchId } }), this.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } })]);
    if (!branch || !tenant) throw AppError.notFound('Branch');
    const url = `${env().APP_URL}/book/${tenant.slug}?branch=${branch.code.toLowerCase()}`;
    const png = await QRCode.toDataURL(url, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    return { branchId, branchName: branch.name, url, png, enabled: branch.publicBookingEnabled };
  }
}

@ApiTags('Public booking')
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly booking: BookingService) {}

  @Public()
  @Get(':slug')
  info(@Param('slug') slug: string) {
    return this.booking.info(slug);
  }

  @Public()
  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query(Zod(publicSlotsQuery)) q: z.infer<typeof publicSlotsQuery>) {
    return this.booking.slots(slug, q);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':slug')
  book(@Param('slug') slug: string, @Body(Zod(bookingBody)) body: z.infer<typeof bookingBody>) {
    return this.booking.book(slug, body);
  }
}

@ApiTags('Public booking')
@ApiBearerAuth()
@Controller('booking')
export class BookingAdminController {
  constructor(private readonly booking: BookingService) {}

  @Get('qr/:branchId')
  @RequirePermissions(PERMISSIONS.BRANCH_READ)
  qr(@Param('branchId') branchId: string) {
    return this.booking.branchQr(branchId);
  }
}

@Module({ imports: [AppointmentsModule, CustomersModule, CatalogModule], controllers: [PublicBookingController, BookingAdminController], providers: [BookingService], exports: [BookingService] })
export class BookingModule {}
