import { Injectable } from '@nestjs/common';
import { Prisma, QueueStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { queueAssignSchema, queueEntrySchema } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { advisoryLock } from '../../common/prisma/locks';
import { AppError } from '../../common/errors/app-error';
import { dateOnly } from '../../common/utils/dates';
import { ActivityService } from '../../core/activity.service';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { SettingsService } from '../../core/settings.service';
import { RealtimeService } from '../../realtime/realtime.gateway';
import { TherapistsService } from '../catalog/therapists.service';
import { assertTransition } from '../appointments/appointments.service';
import { CustomersService, maskContact } from '../customers/customers.service';
import { SessionsService } from '../sessions/sessions.service';

type EntryInput = z.infer<typeof queueEntrySchema>;
type AssignInput = z.infer<typeof queueAssignSchema>;

const QUEUE_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  WAITING: ['CALLED', 'ASSIGNED', 'IN_SERVICE', 'CANCELLED'],
  CALLED: ['ASSIGNED', 'IN_SERVICE', 'WAITING', 'CANCELLED'],
  ASSIGNED: ['IN_SERVICE', 'CALLED', 'WAITING', 'CANCELLED'],
  IN_SERVICE: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

const include = {
  customer: { select: { id: true, name: true, phone: true, email: true, customerCode: true, metrics: { select: { segment: true, visitCount: true } } } },
  service: { select: { id: true, name: true, durationMinutes: true, color: true } },
  therapist: { select: { id: true, name: true, color: true } },
  appointment: { select: { id: true, startTime: true, status: true } },
  sessions: { where: { status: { in: ['IN_PROGRESS', 'PAUSED', 'SCHEDULED'] } }, select: { id: true, status: true, startedAt: true } },
} satisfies Prisma.QueueEntryInclude;

@Injectable()
export class QueueService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly customers: CustomersService,
    private readonly therapists: TherapistsService,
    private readonly sessions: SessionsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  private async branchToday(branchId: string) {
    const branch = await this.db.branch.findFirst({ where: { id: branchId } });
    if (!branch) throw AppError.notFound('Branch');
    const tz = branch.timezone ?? (await this.settings.timezone(RequestContext.requireTenantId()));
    return { branch, tz, date: DateTime.now().setZone(tz).toISODate()! };
  }

  private assertTransition(from: QueueStatus, to: QueueStatus) {
    if (from !== to && !QUEUE_TRANSITIONS[from].includes(to)) {
      throw AppError.invalidState(`Queue entry is ${from.toLowerCase().replace('_', ' ')} and cannot move to ${to.toLowerCase().replace('_', ' ')}.`);
    }
  }

  private notify(branchId: string, entryId?: string) {
    this.realtime.toBranch(branchId, 'queue.updated', { branchId, entryId, at: new Date().toISOString() });
  }

  /** Live board: today's queue plus each therapist's current state. */
  async board(branchId: string) {
    RequestContext.assertBranch(branchId);
    const { tz, date, branch } = await this.branchToday(branchId);
    const [entries, working, activeSessions, upcoming] = await Promise.all([
      this.db.queueEntry.findMany({ where: { branchId, queueDate: dateOnly(date) }, include, orderBy: [{ priority: 'desc' }, { queueNumber: 'asc' }] }),
      this.therapists.workingWindows(branchId, date),
      this.db.therapySession.findMany({
        where: { branchId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
        include: { customer: { select: { name: true } }, service: { select: { name: true, durationMinutes: true } } },
      }),
      this.db.appointment.findMany({
        where: { branchId, appointmentDate: dateOnly(date), status: { in: ['BOOKED', 'CONFIRMED'] }, startTime: { gte: new Date(Date.now() - 30 * 60_000) } },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, service: { select: { name: true } }, therapist: { select: { name: true } } },
        orderBy: { startTime: 'asc' },
        take: 20,
      }),
    ]);
    const now = DateTime.now().setZone(tz);
    const nowMin = now.hour * 60 + now.minute;
    const therapists = working.map((t) => {
      const session = activeSessions.find((s) => s.therapistId === t.therapistId);
      const onShift = t.windows.some((w) => nowMin >= w.start && nowMin < w.end);
      return {
        id: t.therapistId,
        name: t.name,
        color: t.color,
        state: session ? (session.status === 'PAUSED' ? 'PAUSED' : 'BUSY') : onShift ? 'FREE' : 'OFF_SHIFT',
        session: session
          ? {
              id: session.id,
              customer: session.customer.name,
              service: session.service.name,
              startedAt: session.startedAt,
              expectedEnd: session.startedAt ? new Date(session.startedAt.getTime() + session.service.durationMinutes * 60_000 + session.totalPausedSeconds * 1000) : null,
            }
          : null,
        shiftEndsAt: t.windows.find((w) => nowMin < w.end)?.end ?? null,
      };
    });
    const waiting = entries.filter((e) => ['WAITING', 'CALLED', 'ASSIGNED'].includes(e.status));
    return {
      branch: { id: branch.id, name: branch.name },
      date,
      stats: {
        waiting: waiting.length,
        inService: entries.filter((e) => e.status === 'IN_SERVICE').length,
        completed: entries.filter((e) => e.status === 'COMPLETED').length,
        freeTherapists: therapists.filter((t) => t.state === 'FREE').length,
        avgWaitMinutes: waiting.length ? Math.round(waiting.reduce((s, e) => s + (Date.now() - e.checkedInAt.getTime()) / 60_000, 0) / waiting.length) : 0,
      },
      entries: entries.map((e) => ({ ...e, customer: maskContact(e.customer), waitingMinutes: Math.round(((e.startedAt ?? new Date()).getTime() - e.checkedInAt.getTime()) / 60_000) })),
      therapists,
      upcoming: upcoming.map((a) => ({ ...a, customer: maskContact(a.customer), localTime: DateTime.fromJSDate(a.startTime).setZone(tz).toFormat('HH:mm') })),
    };
  }

  private async load(id: string, client: DbOrTx = this.db) {
    const e = await client.queueEntry.findFirst({ where: { id }, include });
    if (!e) throw AppError.notFound('Queue entry');
    RequestContext.assertBranch(e.branchId);
    return e;
  }

  /** Adds a walk-in (existing or new customer) or checks in an appointment. */
  async add(input: EntryInput) {
    RequestContext.assertBranch(input.branchId);
    if (input.appointmentId) return this.checkInAppointment(input.appointmentId, input.notes);
    const tenantId = RequestContext.requireTenantId();
    const { date } = await this.branchToday(input.branchId);

    const entry = await this.db.$transaction(async (tx) => {
      let customerId = input.customerId;
      if (!customerId) {
        if (!input.customer) throw AppError.validation('Select a customer or enter name and phone.');
        const c = await this.customers.findOrCreate({ ...input.customer, branchId: input.branchId, source: 'WALK_IN' }, tx);
        customerId = c.id;
      } else {
        const c = await tx.customer.findFirst({ where: { id: customerId } });
        if (!c) throw AppError.notFound('Customer');
        if (c.status === 'BLOCKED') throw AppError.forbidden('This customer is blocked.');
      }
      const active = await tx.queueEntry.findFirst({ where: { branchId: input.branchId, customerId, queueDate: dateOnly(date), status: { in: ['WAITING', 'CALLED', 'ASSIGNED', 'IN_SERVICE'] } } });
      if (active) throw AppError.conflict(`This customer is already in the queue (token #${active.queueNumber}).`);
      if (input.therapistId) await this.assertTherapist(tx, input.therapistId, input.serviceId);

      const e = await this.createEntry(tx, { tenantId, branchId: input.branchId, date, customerId, serviceId: input.serviceId, therapistId: input.therapistId, priority: input.priority, notes: input.notes });
      await this.activity.record({ customerId, branchId: input.branchId, type: 'WALK_IN', title: `Walk-in, token #${e.queueNumber}`, refType: 'QueueEntry', refId: e.id }, tx);
      await this.events.publish(DomainEvents.QUEUE_UPDATED, { branchId: input.branchId, entryId: e.id, action: 'added' }, tx);
      return e;
    });
    await this.audit.log({ action: 'QUEUE_ENTRY_ADDED', entityType: 'QueueEntry', entityId: entry.id, newValues: { customerId: entry.customerId, queueNumber: entry.queueNumber } });
    this.notify(input.branchId, entry.id);
    return { ...entry, customer: maskContact(entry.customer) };
  }

  private async createEntry(
    tx: DbOrTx,
    p: { tenantId: string; branchId: string; date: string; customerId: string; serviceId?: string | null; therapistId?: string | null; appointmentId?: string; priority?: number; notes?: string },
  ) {
    await advisoryLock(tx, `queue:${p.branchId}:${p.date}`);
    const last = await tx.queueEntry.findFirst({ where: { branchId: p.branchId, queueDate: dateOnly(p.date) }, orderBy: { queueNumber: 'desc' }, select: { queueNumber: true } });
    return tx.queueEntry.create({
      data: {
        tenantId: p.tenantId,
        branchId: p.branchId,
        customerId: p.customerId,
        serviceId: p.serviceId ?? null,
        therapistId: p.therapistId ?? null,
        appointmentId: p.appointmentId,
        queueNumber: (last?.queueNumber ?? 0) + 1,
        queueDate: dateOnly(p.date),
        priority: p.priority ?? 0,
        notes: p.notes,
        status: p.therapistId ? 'ASSIGNED' : 'WAITING',
        assignedAt: p.therapistId ? new Date() : null,
      },
      include,
    });
  }

  async checkInAppointment(appointmentId: string, notes?: string) {
    const tenantId = RequestContext.requireTenantId();
    const appt = await this.db.appointment.findFirst({ where: { id: appointmentId }, include: { queueEntry: true, service: { select: { name: true } } } });
    if (!appt) throw AppError.notFound('Appointment');
    RequestContext.assertBranch(appt.branchId);
    if (appt.queueEntry) return this.load(appt.queueEntry.id);
    assertTransition(appt.status, 'CHECKED_IN');
    const { date } = await this.branchToday(appt.branchId);
    const entry = await this.db.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id: appointmentId }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
      const e = await this.createEntry(tx, {
        tenantId,
        branchId: appt.branchId,
        date,
        customerId: appt.customerId,
        serviceId: appt.serviceId,
        therapistId: appt.therapistId,
        appointmentId,
        // Customers with a booking are served ahead of pure walk-ins.
        priority: 5,
        notes,
      });
      await this.activity.record({ customerId: appt.customerId, branchId: appt.branchId, type: 'CHECKED_IN', title: `Checked in for ${appt.service.name}`, refType: 'Appointment', refId: appointmentId }, tx);
      await this.events.publish(DomainEvents.APPOINTMENT_CHECKED_IN, { appointmentId, customerId: appt.customerId, branchId: appt.branchId, queueEntryId: e.id }, tx);
      return e;
    });
    this.notify(appt.branchId, entry.id);
    this.realtime.toBranch(appt.branchId, 'appointments.changed', { id: appointmentId });
    return { ...entry, customer: maskContact(entry.customer) };
  }

  private async assertTherapist(client: DbOrTx, therapistId: string, serviceId?: string | null) {
    const t = await client.therapist.findFirst({ where: { id: therapistId }, include: { services: { select: { serviceId: true } } } });
    if (!t || t.status !== 'ACTIVE') throw AppError.notFound('Therapist');
    if (serviceId && t.services.length && !t.services.some((s) => s.serviceId === serviceId)) {
      throw AppError.conflict(`${t.name} does not perform this service.`, 'THERAPIST_UNAVAILABLE');
    }
    return t;
  }

  private async transition(id: string, to: QueueStatus, data: Prisma.QueueEntryUncheckedUpdateInput = {}) {
    const e = await this.load(id);
    this.assertTransition(e.status, to);
    const updated = await this.db.queueEntry.update({ where: { id }, data: { ...data, status: to }, include });
    this.notify(e.branchId, id);
    return { ...updated, customer: maskContact(updated.customer) };
  }

  call(id: string) {
    return this.transition(id, 'CALLED', { calledAt: new Date() });
  }

  async assign(id: string, input: AssignInput) {
    const e = await this.load(id);
    const serviceId = input.serviceId ?? e.serviceId;
    await this.assertTherapist(this.db, input.therapistId, serviceId);
    const busy = await this.db.therapySession.findFirst({ where: { therapistId: input.therapistId, status: 'IN_PROGRESS' } });
    const res = await this.transition(id, 'ASSIGNED', { therapistId: input.therapistId, serviceId, assignedAt: new Date() });
    return { ...res, warning: busy ? 'This therapist is currently in another session.' : undefined };
  }

  /** Starts the therapy session for a queue entry (therapist and service required). */
  async start(id: string, room?: string) {
    const e = await this.load(id);
    this.assertTransition(e.status, 'IN_SERVICE');
    if (!e.therapistId || !e.serviceId) throw AppError.invalidState('Assign a therapist and service before starting.');
    const session = await this.sessions.create({
      branchId: e.branchId,
      customerId: e.customerId,
      therapistId: e.therapistId,
      serviceId: e.serviceId,
      appointmentId: e.appointmentId ?? undefined,
      queueEntryId: e.id,
      room,
      startNow: true,
    });
    this.notify(e.branchId, id);
    return { entry: await this.load(id), session };
  }

  /** Completes the queue entry and its running session. */
  async complete(id: string) {
    const e = await this.load(id);
    const running = e.sessions[0];
    if (running) {
      await this.sessions.complete(running.id, {});
      return this.load(id);
    }
    return this.transition(id, 'COMPLETED', { completedAt: new Date() });
  }

  async cancel(id: string) {
    const e = await this.load(id);
    const res = await this.transition(id, 'CANCELLED', { cancelledAt: new Date() });
    await this.audit.log({ action: 'QUEUE_ENTRY_CANCELLED', entityType: 'QueueEntry', entityId: id, oldValues: { status: e.status } });
    return res;
  }

  async reorder(id: string, priority: number) {
    const e = await this.load(id);
    await this.db.queueEntry.update({ where: { id }, data: { priority } });
    this.notify(e.branchId, id);
    return this.load(id);
  }

  /** Estimated wait for a new walk-in: next time any suitable therapist frees up. */
  async estimate(branchId: string, serviceId?: string) {
    const board = await this.board(branchId);
    const free = board.therapists.filter((t) => t.state === 'FREE');
    if (free.length > board.stats.waiting) return { minutes: 0 };
    const ends = board.therapists
      .filter((t) => t.state === 'BUSY' && t.session?.expectedEnd)
      .map((t) => Math.max(0, (new Date(t.session!.expectedEnd!).getTime() - Date.now()) / 60_000))
      .sort((a, b) => a - b);
    const idx = Math.max(0, board.stats.waiting - free.length);
    return { minutes: Math.round(ends[idx] ?? ends[ends.length - 1] ?? 15), serviceId };
  }
}
