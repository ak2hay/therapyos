import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { PERMISSIONS } from '@therapyos/types';
import { appointmentListQuery, AppointmentInput, updateAppointmentSchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { advisoryLock } from '../../common/prisma/locks';
import { AppError } from '../../common/errors/app-error';
import { dateOnly, toIsoDate } from '../../common/utils/dates';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { ServicesService } from '../catalog/services.service';
import { TherapistsService } from '../catalog/therapists.service';
import { maskContact } from '../customers/customers.service';
import { AvailabilityService } from './availability.service';

type ListQuery = z.infer<typeof appointmentListQuery>;
type UpdateInput = z.infer<typeof updateAppointmentSchema>;

/** Allowed status transitions (spec section 14 appointment lifecycle). */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  BOOKED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'BOOKED'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED', 'COMPLETED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function assertTransition(from: AppointmentStatus, to: AppointmentStatus) {
  if (from === to) return;
  if (!APPOINTMENT_TRANSITIONS[from].includes(to)) {
    throw AppError.invalidState(`Cannot change an appointment from ${from.toLowerCase()} to ${to.toLowerCase().replace('_', ' ')}.`);
  }
}

const include = {
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } },
  service: { select: { id: true, name: true, color: true, durationMinutes: true } },
  therapist: { select: { id: true, name: true, color: true } },
  branch: { select: { id: true, name: true } },
  queueEntry: { select: { id: true, queueNumber: true, status: true } },
} satisfies Prisma.AppointmentInclude;

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly availability: AvailabilityService,
    private readonly services: ServicesService,
    private readonly therapists: TherapistsService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  private present<T extends { customer: { phone: string | null; email: string | null } }>(a: T): T {
    return { ...a, customer: maskContact(a.customer) };
  }

  async list(q: ListQuery) {
    const where: Prisma.AppointmentWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    // Therapists without full appointment access only see their own bookings.
    if (!RequestContext.hasPermission(PERMISSIONS.APPOINTMENT_READ)) {
      const therapistId = RequestContext.get('therapistId');
      if (!therapistId) throw AppError.forbidden();
      where.therapistId = therapistId;
    } else if (q.therapistId) where.therapistId = q.therapistId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = { in: q.status.split(',') as AppointmentStatus[] };
    if (q.from || q.to) where.appointmentDate = { gte: q.from ? dateOnly(q.from) : undefined, lte: q.to ? dateOnly(q.to) : undefined };
    const [items, total] = await Promise.all([
      this.db.appointment.findMany({ where, include, orderBy: { startTime: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.appointment.count({ where }),
    ]);
    return paged(items.map((a) => this.present(a)), total, q);
  }

  async get(id: string) {
    const a = await this.db.appointment.findFirst({ where: { id }, include: { ...include, sessions: { select: { id: true, status: true } } } });
    if (!a) throw AppError.notFound('Appointment');
    RequestContext.assertBranch(a.branchId);
    if (!RequestContext.hasPermission(PERMISSIONS.APPOINTMENT_READ) && a.therapistId !== RequestContext.get('therapistId')) throw AppError.notFound('Appointment');
    return this.present(a);
  }

  /** Day view: therapists working at the branch (with their windows) and the day's appointments. */
  async board(branchId: string, date: string) {
    RequestContext.assertBranch(branchId);
    const ctx = await this.availability.context(branchId);
    const [working, appointments, allTherapists] = await Promise.all([
      this.therapists.workingWindows(branchId, date),
      this.db.appointment.findMany({ where: { branchId, appointmentDate: dateOnly(date), status: { notIn: ['CANCELLED'] } }, include, orderBy: { startTime: 'asc' } }),
      this.therapists.list({ branchId, active: true }),
    ]);
    const toLocal = (d: Date) => DateTime.fromJSDate(d).setZone(ctx.tz).toFormat('HH:mm');
    return {
      date,
      open: ctx.branch.openingTime,
      close: ctx.branch.closingTime,
      timezone: ctx.tz,
      therapists: allTherapists.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        windows: working.find((w) => w.therapistId === t.id)?.windows ?? [],
      })),
      appointments: appointments.map((a) => ({ ...this.present(a), localStart: toLocal(a.startTime), localEnd: toLocal(a.endTime) })),
    };
  }

  async create(input: AppointmentInput, opts: { client?: DbOrTx; ignoreHours?: boolean; allowPast?: boolean } = {}) {
    const tenantId = RequestContext.requireTenantId();
    RequestContext.assertBranch(input.branchId);
    const customer = await this.db.customer.findFirst({ where: { id: input.customerId } });
    if (!customer) throw AppError.notFound('Customer');
    if (customer.status === 'BLOCKED') throw AppError.forbidden('This customer is blocked from booking.');
    const service = await this.services.effective(input.serviceId, input.branchId);
    const duration = input.durationMinutes ?? service.durationMinutes;

    const run = async (tx: DbOrTx) => {
      let therapistId = input.therapistId ?? null;
      if (!therapistId) {
        await advisoryLock(tx, `branch-cal:${input.branchId}:${input.date}`);
        therapistId = await this.availability.autoAssign(tx, { branchId: input.branchId, serviceId: input.serviceId, date: input.date, startTime: input.startTime, duration });
        if (!therapistId) throw AppError.conflict('No therapist is free at this time. Pick another slot.', 'SLOT_UNAVAILABLE');
      }
      await advisoryLock(tx, `therapist-cal:${therapistId}:${input.date}`);
      const { startUtc, endUtc } = await this.availability.assertBookable(tx, {
        branchId: input.branchId,
        therapistId,
        serviceId: input.serviceId,
        date: input.date,
        startTime: input.startTime,
        duration,
        ignoreHours: opts.ignoreHours,
      });
      if (!opts.allowPast && startUtc.getTime() < Date.now() - 5 * 60_000) throw AppError.invalidState('Appointments cannot be booked in the past.');
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          serviceId: input.serviceId,
          therapistId,
          appointmentDate: dateOnly(input.date),
          startTime: startUtc,
          endTime: endUtc,
          source: input.source as never,
          notes: input.notes,
          createdBy: RequestContext.userId,
          status: 'BOOKED',
        },
        include,
      });
      await this.activity.record(
        {
          customerId: input.customerId,
          branchId: input.branchId,
          type: 'APPOINTMENT_BOOKED',
          title: `Booked ${appointment.service.name} with ${appointment.therapist?.name ?? 'any therapist'}`,
          refType: 'Appointment',
          refId: appointment.id,
          meta: { date: input.date, time: input.startTime, source: input.source },
        },
        tx,
      );
      await this.events.publish(
        DomainEvents.APPOINTMENT_CREATED,
        { appointmentId: appointment.id, customerId: input.customerId, branchId: input.branchId, therapistId, serviceId: input.serviceId, startTime: startUtc.toISOString(), source: input.source },
        tx,
      );
      return appointment;
    };

    const appointment = opts.client ? await run(opts.client) : await this.db.$transaction(run, { timeout: 15_000 });
    await this.audit.log({ action: 'APPOINTMENT_CREATED', entityType: 'Appointment', entityId: appointment.id, newValues: input });
    this.realtime.toBranch(input.branchId, 'appointments.changed', { id: appointment.id, date: input.date });
    return this.present(appointment);
  }

  private async load(id: string, client: DbOrTx = this.db) {
    const a = await client.appointment.findFirst({ where: { id }, include });
    if (!a) throw AppError.notFound('Appointment');
    RequestContext.assertBranch(a.branchId);
    return a;
  }

  async update(id: string, input: UpdateInput) {
    const before = await this.load(id);
    if (['COMPLETED', 'CANCELLED', 'NO_SHOW', 'IN_PROGRESS'].includes(before.status) && (input.date || input.startTime || input.therapistId || input.serviceId)) {
      throw AppError.invalidState('This appointment can no longer be rescheduled.');
    }
    const ctx = await this.availability.context(before.branchId);
    const currentDate = toIsoDate(before.appointmentDate);
    const currentTime = DateTime.fromJSDate(before.startTime).setZone(ctx.tz).toFormat('HH:mm');
    const reschedule = !!(input.date || input.startTime || input.therapistId || input.serviceId || input.durationMinutes);

    const updated = await this.db.$transaction(async (tx) => {
      const data: Prisma.AppointmentUncheckedUpdateInput = { notes: input.notes };
      if (reschedule) {
        const date = input.date ?? currentDate;
        const startTime = input.startTime ?? currentTime;
        const serviceId = input.serviceId ?? before.serviceId;
        const service = await this.services.effective(serviceId, before.branchId, tx);
        const duration = input.durationMinutes ?? (input.serviceId ? service.durationMinutes : Math.round((before.endTime.getTime() - before.startTime.getTime()) / 60_000));
        const therapistId = input.therapistId ?? before.therapistId;
        if (!therapistId) throw AppError.invalidState('Assign a therapist to reschedule.');
        await advisoryLock(tx, `therapist-cal:${therapistId}:${date}`);
        const { startUtc, endUtc } = await this.availability.assertBookable(tx, {
          branchId: before.branchId,
          therapistId,
          serviceId,
          date,
          startTime,
          duration,
          excludeAppointmentId: id,
        });
        if (startUtc.getTime() < Date.now() - 5 * 60_000) throw AppError.invalidState('Appointments cannot be moved into the past.');
        Object.assign(data, { appointmentDate: dateOnly(date), startTime: startUtc, endTime: endUtc, therapistId, serviceId, reminderSentAt: null });
      }
      if (input.status) {
        assertTransition(before.status, input.status);
        data.status = input.status;
        if (input.status === 'NO_SHOW') {
          await tx.customerMetrics.updateMany({ where: { customerId: before.customerId }, data: { noShowCount: { increment: 1 } } });
        }
      }
      const a = await tx.appointment.update({ where: { id }, data, include });
      if (reschedule) {
        await this.activity.record(
          { customerId: before.customerId, branchId: before.branchId, type: 'APPOINTMENT_RESCHEDULED', title: `Rescheduled ${a.service.name}`, refType: 'Appointment', refId: id, meta: { from: `${currentDate} ${currentTime}`, to: `${input.date ?? currentDate} ${input.startTime ?? currentTime}` } },
          tx,
        );
      }
      if (input.status === 'NO_SHOW') {
        await this.activity.record({ customerId: before.customerId, branchId: before.branchId, type: 'APPOINTMENT_NO_SHOW', title: `Missed ${a.service.name}`, refType: 'Appointment', refId: id }, tx);
        await this.events.publish(DomainEvents.APPOINTMENT_NO_SHOW, { appointmentId: id, customerId: before.customerId, branchId: before.branchId }, tx);
      }
      return a;
    });
    await this.audit.log({ action: reschedule ? 'APPOINTMENT_RESCHEDULED' : 'APPOINTMENT_UPDATED', entityType: 'Appointment', entityId: id, oldValues: { status: before.status, startTime: before.startTime, therapistId: before.therapistId }, newValues: input });
    this.realtime.toBranch(before.branchId, 'appointments.changed', { id });
    return this.present(updated);
  }

  async cancel(id: string, reason?: string) {
    const before = await this.load(id);
    assertTransition(before.status, 'CANCELLED');
    const a = await this.db.$transaction(async (tx) => {
      const updated = await tx.appointment.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() }, include });
      if (before.queueEntry && ['WAITING', 'CALLED', 'ASSIGNED'].includes(before.queueEntry.status)) {
        await tx.queueEntry.update({ where: { id: before.queueEntry.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      }
      await this.activity.record({ customerId: before.customerId, branchId: before.branchId, type: 'APPOINTMENT_CANCELLED', title: `Cancelled ${before.service.name}`, refType: 'Appointment', refId: id, meta: { reason } }, tx);
      await this.events.publish(DomainEvents.APPOINTMENT_CANCELLED, { appointmentId: id, customerId: before.customerId, branchId: before.branchId, reason: reason ?? null }, tx);
      return updated;
    });
    await this.audit.log({ action: 'APPOINTMENT_CANCELLED', entityType: 'Appointment', entityId: id, oldValues: { status: before.status }, newValues: { reason } });
    this.realtime.toBranch(before.branchId, 'appointments.changed', { id });
    return this.present(a);
  }
}
