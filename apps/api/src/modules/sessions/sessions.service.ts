import { Injectable } from '@nestjs/common';
import { Prisma, SessionStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { PERMISSIONS } from '@therapyos/types';
import { completeSessionSchema, sessionListQuery, sessionSchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { dateOnly } from '../../common/utils/dates';
import { paged } from '../../common/utils/pagination';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { ServicesService } from '../catalog/services.service';
import { assertTransition } from '../appointments/appointments.service';
import { maskContact } from '../customers/customers.service';

type CreateInput = z.infer<typeof sessionSchema>;
type CompleteInput = z.infer<typeof completeSessionSchema>;
type ListQuery = z.infer<typeof sessionListQuery>;

const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const include = {
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true } },
  service: { select: { id: true, name: true, durationMinutes: true, color: true } },
  therapist: { select: { id: true, name: true, color: true } },
  branch: { select: { id: true, name: true } },
  feedback: { select: { rating: true, comment: true } },
} satisfies Prisma.TherapySessionInclude;

@Injectable()
export class SessionsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly services: ServicesService,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Therapists see contact details only when the tenant allows it or they hold the contact permission. */
  private async present<T extends { customer: { phone: string | null; email: string | null } }>(s: T): Promise<T> {
    const tenantId = RequestContext.requireTenantId();
    const therapistId = RequestContext.get('therapistId');
    if (therapistId && !RequestContext.hasPermission(PERMISSIONS.CUSTOMER_CONTACT_VIEW)) {
      const allowed = await this.settings.get<boolean>(tenantId, 'THERAPIST_CAN_VIEW_CUSTOMER_PHONE');
      if (allowed) return s;
    }
    return { ...s, customer: maskContact(s.customer) };
  }

  private canReadAll() {
    return RequestContext.hasPermission(PERMISSIONS.SESSION_READ);
  }

  private ownTherapistId() {
    const id = RequestContext.get('therapistId');
    if (!id) throw AppError.forbidden();
    return id;
  }

  async list(q: ListQuery) {
    const where: Prisma.TherapySessionWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.mine || !this.canReadAll()) where.therapistId = this.ownTherapistId();
    else if (q.therapistId) where.therapistId = q.therapistId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = { in: q.status.split(',') as SessionStatus[] };
    if (q.date) {
      const tz = await this.settings.timezone(RequestContext.requireTenantId());
      const start = DateTime.fromISO(q.date, { zone: tz }).startOf('day');
      where.OR = [
        { startedAt: { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() } },
        { startedAt: null, createdAt: { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() } },
      ];
    }
    const [items, total] = await Promise.all([
      this.db.therapySession.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.therapySession.count({ where }),
    ]);
    return paged(await Promise.all(items.map((s) => this.present(s))), total, q);
  }

  private async load(id: string, client: DbOrTx = this.db) {
    const s = await client.therapySession.findFirst({ where: { id }, include });
    if (!s) throw AppError.notFound('Session');
    RequestContext.assertBranch(s.branchId);
    if (!this.canReadAll() && s.therapistId !== RequestContext.get('therapistId')) throw AppError.notFound('Session');
    return s;
  }

  async get(id: string) {
    const s = await this.load(id);
    const history = await this.db.therapySession.findMany({
      where: { customerId: s.customerId, status: 'COMPLETED', id: { not: id } },
      select: { id: true, completedAt: true, notes: true, service: { select: { name: true } }, therapist: { select: { name: true } } },
      orderBy: { completedAt: 'desc' },
      take: 5,
    });
    return { ...(await this.present(s)), elapsedSeconds: this.elapsed(s), previousSessions: history };
  }

  private elapsed(s: { startedAt: Date | null; pausedAt: Date | null; completedAt: Date | null; totalPausedSeconds: number }) {
    if (!s.startedAt) return 0;
    const end = s.completedAt ?? s.pausedAt ?? new Date();
    return Math.max(0, Math.round((end.getTime() - s.startedAt.getTime()) / 1000) - s.totalPausedSeconds);
  }

  private assertTransition(from: SessionStatus, to: SessionStatus) {
    if (!SESSION_TRANSITIONS[from].includes(to)) {
      throw AppError.invalidState(`Session is ${from.toLowerCase().replace('_', ' ')} and cannot be ${to.toLowerCase().replace('_', ' ')}.`);
    }
  }

  /** Therapists may only drive their own sessions unless they hold full session access. */
  private assertOwner(s: { therapistId: string }) {
    if (!this.canReadAll() && s.therapistId !== RequestContext.get('therapistId')) throw AppError.forbidden('This is not your session.');
  }

  async create(input: CreateInput, client?: DbOrTx) {
    const tenantId = RequestContext.requireTenantId();
    RequestContext.assertBranch(input.branchId);
    if (!this.canReadAll() && input.therapistId !== RequestContext.get('therapistId')) throw AppError.forbidden('You can only start your own sessions.');

    const run = async (tx: DbOrTx) => {
      const [customer, therapist] = await Promise.all([
        tx.customer.findFirst({ where: { id: input.customerId } }),
        tx.therapist.findFirst({ where: { id: input.therapistId }, include: { services: { select: { serviceId: true } } } }),
      ]);
      if (!customer) throw AppError.notFound('Customer');
      if (!therapist || therapist.status !== 'ACTIVE') throw AppError.notFound('Therapist');
      if (therapist.services.length && !therapist.services.some((s) => s.serviceId === input.serviceId)) {
        throw AppError.conflict(`${therapist.name} does not perform this service.`, 'THERAPIST_UNAVAILABLE');
      }
      await this.services.effective(input.serviceId, input.branchId, tx);
      if (input.startNow) {
        const busy = await tx.therapySession.findFirst({ where: { therapistId: input.therapistId, status: 'IN_PROGRESS' }, include: { customer: { select: { name: true } } } });
        if (busy) throw AppError.conflict(`${therapist.name} is already in a session with ${busy.customer.name}.`, 'THERAPIST_UNAVAILABLE');
      }

      if (input.appointmentId) {
        const appt = await tx.appointment.findFirst({ where: { id: input.appointmentId } });
        if (!appt) throw AppError.notFound('Appointment');
        if (appt.customerId !== input.customerId) throw AppError.validation('Appointment belongs to a different customer.');
        const existing = await tx.therapySession.findFirst({ where: { appointmentId: appt.id, status: { notIn: ['CANCELLED'] } } });
        if (existing) throw AppError.conflict('A session already exists for this appointment.');
        if (input.startNow) {
          if (appt.status === 'BOOKED' || appt.status === 'CONFIRMED') {
            await tx.appointment.update({ where: { id: appt.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
            appt.status = 'CHECKED_IN';
          }
          assertTransition(appt.status, 'IN_PROGRESS');
          await tx.appointment.update({ where: { id: appt.id }, data: { status: 'IN_PROGRESS', therapistId: input.therapistId } });
        }
      }
      if (input.queueEntryId) {
        const q = await tx.queueEntry.findFirst({ where: { id: input.queueEntryId } });
        if (!q) throw AppError.notFound('Queue entry');
        if (input.startNow) {
          await tx.queueEntry.update({ where: { id: q.id }, data: { status: 'IN_SERVICE', startedAt: new Date(), therapistId: input.therapistId, serviceId: input.serviceId } });
        }
      }

      const session = await tx.therapySession.create({
        data: {
          tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          therapistId: input.therapistId,
          serviceId: input.serviceId,
          appointmentId: input.appointmentId,
          queueEntryId: input.queueEntryId,
          customerPackageId: input.customerPackageId,
          customerMembershipId: input.customerMembershipId,
          room: input.room,
          status: input.startNow ? 'IN_PROGRESS' : 'SCHEDULED',
          startedAt: input.startNow ? new Date() : null,
          createdBy: RequestContext.userId,
        },
        include,
      });
      if (input.startNow) {
        await this.activity.record({ customerId: input.customerId, branchId: input.branchId, type: 'SESSION_STARTED', title: `${session.service.name} started with ${session.therapist.name}`, refType: 'TherapySession', refId: session.id }, tx);
        await this.events.publish(DomainEvents.SESSION_STARTED, { sessionId: session.id, customerId: input.customerId, therapistId: input.therapistId, branchId: input.branchId }, tx);
      }
      return session;
    };

    const session = client ? await run(client) : await this.db.$transaction(run, { timeout: 15_000 });
    this.broadcast(session.branchId, session.id, session.therapistId);
    return this.present(session);
  }

  private broadcast(branchId: string, sessionId: string, therapistId: string) {
    this.realtime.toBranch(branchId, 'sessions.changed', { id: sessionId });
    this.realtime.toBranch(branchId, 'queue.updated', { branchId });
    this.realtime.emit(`therapist:${therapistId}`, 'sessions.changed', { id: sessionId });
  }

  async start(id: string) {
    const s = await this.load(id);
    this.assertOwner(s);
    this.assertTransition(s.status, 'IN_PROGRESS');
    const busy = await this.db.therapySession.findFirst({ where: { therapistId: s.therapistId, status: 'IN_PROGRESS', id: { not: id } } });
    if (busy) throw AppError.conflict('Finish your current session first.', 'THERAPIST_UNAVAILABLE');
    await this.db.$transaction(async (tx) => {
      await tx.therapySession.update({ where: { id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
      if (s.appointmentId) {
        const appt = await tx.appointment.findFirst({ where: { id: s.appointmentId } });
        if (appt && appt.status !== 'IN_PROGRESS') {
          if (appt.status === 'BOOKED' || appt.status === 'CONFIRMED') await tx.appointment.update({ where: { id: appt.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
          await tx.appointment.update({ where: { id: appt.id }, data: { status: 'IN_PROGRESS' } });
        }
      }
      if (s.queueEntryId) await tx.queueEntry.update({ where: { id: s.queueEntryId }, data: { status: 'IN_SERVICE', startedAt: new Date() } });
      await this.activity.record({ customerId: s.customerId, branchId: s.branchId, type: 'SESSION_STARTED', title: `${s.service.name} started with ${s.therapist.name}`, refType: 'TherapySession', refId: id }, tx);
      await this.events.publish(DomainEvents.SESSION_STARTED, { sessionId: id, customerId: s.customerId, therapistId: s.therapistId, branchId: s.branchId }, tx);
    });
    this.broadcast(s.branchId, id, s.therapistId);
    return this.get(id);
  }

  async pause(id: string) {
    const s = await this.load(id);
    this.assertOwner(s);
    this.assertTransition(s.status, 'PAUSED');
    await this.db.therapySession.update({ where: { id }, data: { status: 'PAUSED', pausedAt: new Date() } });
    this.broadcast(s.branchId, id, s.therapistId);
    return this.get(id);
  }

  async resume(id: string) {
    const s = await this.load(id);
    this.assertOwner(s);
    this.assertTransition(s.status, 'IN_PROGRESS');
    const pausedFor = s.pausedAt ? Math.round((Date.now() - s.pausedAt.getTime()) / 1000) : 0;
    await this.db.therapySession.update({ where: { id }, data: { status: 'IN_PROGRESS', pausedAt: null, totalPausedSeconds: { increment: pausedFor } } });
    this.broadcast(s.branchId, id, s.therapistId);
    return this.get(id);
  }

  /**
   * Completes the session atomically with its appointment and queue entry and emits
   * `session.completed`; metrics, commission, package redemption, stock consumption and the
   * feedback request are handled asynchronously by event handlers.
   */
  async complete(id: string, input: CompleteInput) {
    const s = await this.load(id);
    this.assertOwner(s);
    if (s.status === 'SCHEDULED') throw AppError.invalidState('Start the session before completing it.');
    this.assertTransition(s.status, 'COMPLETED');
    const now = new Date();
    const pausedFor = s.status === 'PAUSED' && s.pausedAt ? Math.round((now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
    const service = await this.services.effective(s.serviceId, s.branchId);
    const customerPackageId = input.customerPackageId ?? s.customerPackageId;

    await this.db.$transaction(async (tx) => {
      const res = await tx.therapySession.updateMany({
        where: { id, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          pausedAt: null,
          totalPausedSeconds: { increment: pausedFor },
          notes: input.notes ?? s.notes,
          customerPackageId,
        },
      });
      if (res.count === 0) throw AppError.invalidState('Session was already completed.');
      if (s.appointmentId) await tx.appointment.updateMany({ where: { id: s.appointmentId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, data: { status: 'COMPLETED' } });
      if (s.queueEntryId) await tx.queueEntry.updateMany({ where: { id: s.queueEntryId, status: { not: 'CANCELLED' } }, data: { status: 'COMPLETED', completedAt: now } });
      await this.activity.record(
        { customerId: s.customerId, branchId: s.branchId, type: 'SESSION_COMPLETED', title: `${s.service.name} with ${s.therapist.name}`, refType: 'TherapySession', refId: id, meta: { durationSeconds: this.elapsed({ ...s, completedAt: now, pausedAt: null, totalPausedSeconds: s.totalPausedSeconds + pausedFor }) } },
        tx,
      );
      await this.events.publish(
        DomainEvents.SESSION_COMPLETED,
        {
          sessionId: id,
          customerId: s.customerId,
          therapistId: s.therapistId,
          serviceId: s.serviceId,
          branchId: s.branchId,
          appointmentId: s.appointmentId,
          customerPackageId: customerPackageId ?? null,
          customerMembershipId: s.customerMembershipId ?? null,
          servicePrice: service.price,
          productsUsed: input.productsUsed ?? [],
          completedAt: now.toISOString(),
        },
        tx,
      );
    });
    await this.audit.log({ action: 'SESSION_COMPLETED', entityType: 'TherapySession', entityId: id, newValues: { customerPackageId, productsUsed: input.productsUsed } });
    this.broadcast(s.branchId, id, s.therapistId);
    if (s.appointmentId) this.realtime.toBranch(s.branchId, 'appointments.changed', { id: s.appointmentId });
    return this.get(id);
  }

  async cancel(id: string, reason?: string) {
    const s = await this.load(id);
    this.assertOwner(s);
    this.assertTransition(s.status, 'CANCELLED');
    await this.db.$transaction(async (tx) => {
      await tx.therapySession.update({ where: { id }, data: { status: 'CANCELLED', notes: reason ? `${s.notes ? `${s.notes}\n` : ''}Cancelled: ${reason}` : s.notes } });
      // Put the customer back in line / back to checked-in so they can be re-assigned.
      if (s.queueEntryId) await tx.queueEntry.updateMany({ where: { id: s.queueEntryId, status: 'IN_SERVICE' }, data: { status: 'WAITING', startedAt: null } });
      if (s.appointmentId) await tx.appointment.updateMany({ where: { id: s.appointmentId, status: 'IN_PROGRESS' }, data: { status: 'CHECKED_IN' } });
    });
    await this.audit.log({ action: 'SESSION_CANCELLED', entityType: 'TherapySession', entityId: id, newValues: { reason } });
    this.broadcast(s.branchId, id, s.therapistId);
    return this.get(id);
  }

  async updateNotes(id: string, notes: string) {
    const s = await this.load(id);
    this.assertOwner(s);
    await this.db.therapySession.update({ where: { id }, data: { notes } });
    return this.get(id);
  }

  /** Therapist's day: own appointments, active session, completed sessions and month commission. */
  async myDay(date?: string) {
    const therapistId = this.ownTherapistId();
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const day = date ?? DateTime.now().setZone(tz).toISODate()!;
    const start = DateTime.fromISO(day, { zone: tz }).startOf('day');
    const monthStart = start.startOf('month').toJSDate();
    const [appointments, active, completed, queue, commission] = await Promise.all([
      this.db.appointment.findMany({
        where: { therapistId, appointmentDate: dateOnly(day), status: { notIn: ['CANCELLED'] } },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, service: { select: { id: true, name: true, durationMinutes: true } }, branch: { select: { id: true, name: true } } },
        orderBy: { startTime: 'asc' },
      }),
      this.db.therapySession.findFirst({ where: { therapistId, status: { in: ['IN_PROGRESS', 'PAUSED'] } }, include }),
      this.db.therapySession.findMany({ where: { therapistId, status: 'COMPLETED', completedAt: { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() } }, include, orderBy: { completedAt: 'desc' } }),
      this.db.queueEntry.findMany({
        where: { therapistId, queueDate: dateOnly(day), status: { in: ['ASSIGNED', 'CALLED'] } },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, service: { select: { id: true, name: true } } },
        orderBy: [{ priority: 'desc' }, { queueNumber: 'asc' }],
      }),
      this.db.therapistCommission.aggregate({ where: { therapistId, createdAt: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
    ]);
    const toLocal = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');
    return {
      date: day,
      activeSession: active ? { ...(await this.present(active)), elapsedSeconds: this.elapsed(active) } : null,
      appointments: appointments.map((a) => ({ ...a, customer: maskContact(a.customer), localStart: toLocal(a.startTime), localEnd: toLocal(a.endTime) })),
      assignedQueue: queue.map((e) => ({ ...e, customer: maskContact(e.customer) })),
      completed: await Promise.all(completed.map((s) => this.present(s))),
      stats: {
        appointments: appointments.length,
        completedToday: completed.length,
        monthSessions: commission._count,
        monthCommission: Number(commission._sum.amount ?? 0),
      },
    };
  }
}
