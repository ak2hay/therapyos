import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { dateOnly, zonedToUtc } from '../../common/utils/dates';
import { SettingsService } from '../../core/settings.service';
import { ServicesService } from '../catalog/services.service';
import { fromMinutes, TherapistsService, toMinutes, Window } from '../catalog/therapists.service';

export const BLOCKING_STATUSES = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] as const;

export interface Busy {
  therapistId: string;
  start: number;
  end: number;
  appointmentId?: string;
}

export interface SlotQuery {
  branchId: string;
  serviceId: string;
  date: string;
  therapistId?: string;
  durationMinutes?: number;
  excludeAppointmentId?: string;
}

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly services: ServicesService,
    private readonly therapists: TherapistsService,
  ) {}

  async context(branchId: string) {
    const tenantId = RequestContext.requireTenantId();
    const [branch, all] = await Promise.all([this.db.branch.findFirst({ where: { id: branchId } }), this.settings.getAll(tenantId)]);
    if (!branch) throw AppError.notFound('Branch');
    const tz = branch.timezone ?? (all.TIMEZONE as string) ?? 'Asia/Kolkata';
    return {
      branch,
      tz,
      buffer: Number(all.APPOINTMENT_BUFFER ?? 10),
      interval: Number(all.SLOT_INTERVAL ?? 15),
      open: toMinutes(branch.openingTime),
      close: toMinutes(branch.closingTime),
    };
  }

  /** Busy intervals (minutes since local midnight) per therapist across all branches for the date. */
  async busy(date: string, tz: string, therapistIds: string[], client: DbOrTx = this.db, excludeAppointmentId?: string): Promise<Busy[]> {
    if (!therapistIds.length) return [];
    const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
    const toLocal = (d: Date) => Math.round(DateTime.fromJSDate(d).setZone(tz).diff(dayStart, 'minutes').minutes);
    const [appointments, sessions] = await Promise.all([
      client.appointment.findMany({
        where: {
          therapistId: { in: therapistIds },
          appointmentDate: dateOnly(date),
          status: { in: [...BLOCKING_STATUSES] },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
        select: { id: true, therapistId: true, startTime: true, endTime: true },
      }),
      // Walk-in sessions without an appointment also occupy the therapist.
      client.therapySession.findMany({
        where: {
          therapistId: { in: therapistIds },
          appointmentId: null,
          status: { in: ['IN_PROGRESS', 'PAUSED', 'SCHEDULED'] },
          createdAt: { gte: dayStart.toUTC().toJSDate(), lt: dayStart.plus({ days: 1 }).toUTC().toJSDate() },
        },
        include: { service: { select: { durationMinutes: true } } },
      }),
    ]);
    const busy: Busy[] = appointments.map((a) => ({ therapistId: a.therapistId!, start: toLocal(a.startTime), end: toLocal(a.endTime), appointmentId: a.id }));
    for (const s of sessions) {
      const start = toLocal(s.startedAt ?? s.createdAt);
      busy.push({ therapistId: s.therapistId, start, end: start + s.service.durationMinutes });
    }
    return busy;
  }

  static fits(start: number, duration: number, windows: Window[], busy: Busy[], buffer: number) {
    const end = start + duration;
    if (!windows.some((w) => start >= w.start && end <= w.end)) return false;
    return !busy.some((b) => start < b.end + buffer && b.start < end + buffer);
  }

  /** Bookable start times for a service, with the therapists free at each time. */
  async slots(q: SlotQuery) {
    RequestContext.assertBranch(q.branchId);
    const ctx = await this.context(q.branchId);
    const service = await this.services.effective(q.serviceId, q.branchId);
    const duration = q.durationMinutes ?? service.durationMinutes;

    let working = await this.therapists.workingWindows(q.branchId, q.date, q.therapistId ? [q.therapistId] : undefined);
    working = working.filter((t) => !t.serviceIds.length || t.serviceIds.includes(q.serviceId));
    const busy = await this.busy(q.date, ctx.tz, working.map((t) => t.therapistId), this.db, q.excludeAppointmentId);

    const now = DateTime.now().setZone(ctx.tz);
    const isToday = now.toISODate() === q.date;
    const earliest = isToday ? now.hour * 60 + now.minute : 0;
    const slots: { time: string; therapistIds: string[] }[] = [];
    for (let m = ctx.open; m + duration <= ctx.close; m += ctx.interval) {
      if (m < earliest) continue;
      const free = working
        .filter((t) => AvailabilityService.fits(m, duration, t.windows, busy.filter((b) => b.therapistId === t.therapistId), ctx.buffer))
        .map((t) => t.therapistId);
      if (free.length) slots.push({ time: fromMinutes(m), therapistIds: free });
    }
    return {
      date: q.date,
      branchId: q.branchId,
      serviceId: q.serviceId,
      durationMinutes: duration,
      price: service.price,
      therapists: working.map((t) => ({ id: t.therapistId, name: t.name, color: t.color })),
      slots,
    };
  }

  /**
   * Validates that a therapist can take the booking and returns the UTC interval. Throws
   * THERAPIST_UNAVAILABLE / SLOT_UNAVAILABLE. Call inside the booking transaction after locking.
   */
  async assertBookable(
    client: DbOrTx,
    p: { branchId: string; therapistId: string; serviceId: string; date: string; startTime: string; duration: number; excludeAppointmentId?: string; ignoreHours?: boolean },
  ) {
    const ctx = await this.context(p.branchId);
    const start = toMinutes(p.startTime);
    if (!p.ignoreHours && (start < ctx.open || start + p.duration > ctx.close)) {
      throw AppError.conflict(`Outside branch hours (${ctx.branch.openingTime}-${ctx.branch.closingTime}).`, 'SLOT_UNAVAILABLE');
    }
    const [working] = await this.therapists.workingWindows(p.branchId, p.date, [p.therapistId], client);
    if (!working || !working.windows.some((w) => start >= w.start && start + p.duration <= w.end)) {
      throw AppError.conflict('The therapist is not working at this time.', 'THERAPIST_UNAVAILABLE');
    }
    if (working.serviceIds.length && !working.serviceIds.includes(p.serviceId)) {
      throw AppError.conflict('The therapist does not perform this service.', 'THERAPIST_UNAVAILABLE');
    }
    const busy = await this.busy(p.date, ctx.tz, [p.therapistId], client, p.excludeAppointmentId);
    if (!AvailabilityService.fits(start, p.duration, working.windows, busy, ctx.buffer)) {
      throw AppError.conflict('The therapist already has a booking at this time.', 'SLOT_UNAVAILABLE');
    }
    return this.interval(p.date, p.startTime, p.duration, ctx.tz);
  }

  interval(date: string, startTime: string, duration: number, tz: string) {
    const startUtc = zonedToUtc(date, startTime, tz);
    return { startUtc, endUtc: new Date(startUtc.getTime() + duration * 60_000) };
  }

  /** Picks the least-loaded free therapist for a slot, or null when nobody is free. */
  async autoAssign(client: DbOrTx, p: { branchId: string; serviceId: string; date: string; startTime: string; duration: number }) {
    const ctx = await this.context(p.branchId);
    const start = toMinutes(p.startTime);
    const working = (await this.therapists.workingWindows(p.branchId, p.date, undefined, client)).filter(
      (t) => !t.serviceIds.length || t.serviceIds.includes(p.serviceId),
    );
    const busy = await this.busy(p.date, ctx.tz, working.map((t) => t.therapistId), client);
    const candidates = working
      .filter((t) => AvailabilityService.fits(start, p.duration, t.windows, busy.filter((b) => b.therapistId === t.therapistId), ctx.buffer))
      .map((t) => ({ id: t.therapistId, load: busy.filter((b) => b.therapistId === t.therapistId).length }))
      .sort((a, b) => a.load - b.load);
    return candidates[0]?.id ?? null;
  }
}
