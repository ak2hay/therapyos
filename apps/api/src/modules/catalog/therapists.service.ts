import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { scheduleExceptionSchema, scheduleSchema, TherapistInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { dateOnly, dayOfWeek } from '../../common/utils/dates';
import { AuditService } from '../../core/audit.service';
import { SERVICE_COLORS } from './business-templates';

type ScheduleInput = z.infer<typeof scheduleSchema>;
type ExceptionInput = z.infer<typeof scheduleExceptionSchema>;

/** Minutes since midnight for an HH:mm string. */
export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface Window {
  start: number;
  end: number;
}

/** Removes `block` from each window, splitting windows where needed. */
export function subtractWindow(windows: Window[], block: Window): Window[] {
  const out: Window[] = [];
  for (const w of windows) {
    if (block.end <= w.start || block.start >= w.end) {
      out.push(w);
      continue;
    }
    if (block.start > w.start) out.push({ start: w.start, end: block.start });
    if (block.end < w.end) out.push({ start: block.end, end: w.end });
  }
  return out;
}

@Injectable()
export class TherapistsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private readonly include = {
    services: { select: { serviceId: true, service: { select: { id: true, name: true } } } },
    schedules: { orderBy: [{ dayOfWeek: 'asc' as const }, { startTime: 'asc' as const }] },
    user: { select: { id: true, email: true, status: true } },
  };

  async list(q: { branchId?: string; active?: boolean; serviceId?: string; search?: string }) {
    const where: Prisma.TherapistWhereInput = {};
    if (q.active) where.status = 'ACTIVE';
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' };
    if (q.serviceId) where.services = { some: { serviceId: q.serviceId } };
    if (q.branchId) {
      RequestContext.assertBranch(q.branchId);
      where.OR = [{ primaryBranchId: q.branchId }, { schedules: { some: { branchId: q.branchId } } }];
    } else if (!RequestContext.get('allBranches') && RequestContext.get('userId')) {
      const ids = RequestContext.get('branchIds') ?? [];
      where.OR = [{ primaryBranchId: { in: ids } }, { schedules: { some: { branchId: { in: ids } } } }];
    }
    return this.db.therapist.findMany({ where, include: this.include, orderBy: { name: 'asc' } });
  }

  async get(id: string) {
    const t = await this.db.therapist.findFirst({
      where: { id },
      include: {
        ...this.include,
        exceptions: { where: { date: { gte: dateOnly(new Date().toISOString().slice(0, 10)) } }, orderBy: { date: 'asc' } },
      },
    });
    if (!t) throw AppError.notFound('Therapist');
    return t;
  }

  /** The therapist profile linked to the current user (for therapist self-service screens). */
  async me() {
    const therapistId = RequestContext.get('therapistId');
    if (!therapistId) throw AppError.notFound('Therapist profile');
    return this.get(therapistId);
  }

  private async nextCode(client: DbOrTx) {
    const count = await client.therapist.count();
    let n = count + 1;
    while (await client.therapist.findFirst({ where: { employeeCode: `T${String(n).padStart(3, '0')}` } })) n++;
    return `T${String(n).padStart(3, '0')}`;
  }

  private async validate(input: Partial<TherapistInput>) {
    if (input.primaryBranchId) RequestContext.assertBranch(input.primaryBranchId);
    if (input.serviceIds?.length) {
      const count = await this.db.service.count({ where: { id: { in: input.serviceIds } } });
      if (count !== new Set(input.serviceIds).size) throw AppError.notFound('Service');
    }
    if (input.userId) {
      const user = await this.db.user.findFirst({ where: { id: input.userId } });
      if (!user) throw AppError.notFound('User');
    }
    if (input.commissionType === 'TIERED' && !input.commissionTiers?.length) {
      throw AppError.validation('Tiered commission needs at least one tier.');
    }
    if (input.commissionType === 'PERCENTAGE' && (input.commissionValue ?? 0) > 100) {
      throw AppError.validation('Commission percentage cannot exceed 100.');
    }
  }

  async create(input: Partial<TherapistInput> & { name: string }) {
    const tenantId = RequestContext.requireTenantId();
    await this.validate(input);
    const { serviceIds, commissionTiers, joiningDate, ...data } = input;
    const count = await this.db.therapist.count();
    const therapist = await this.db.therapist.create({
      data: {
        ...data,
        tenantId,
        employeeCode: data.employeeCode || (await this.nextCode(this.db)),
        joiningDate: joiningDate ? dateOnly(joiningDate) : undefined,
        commissionTiers: commissionTiers as Prisma.InputJsonValue | undefined,
        color: data.color ?? SERVICE_COLORS[(count + 3) % SERVICE_COLORS.length],
        services: serviceIds?.length ? { create: serviceIds.map((serviceId) => ({ serviceId, tenantId })) } : undefined,
      },
    });
    await this.audit.log({ action: 'THERAPIST_CREATED', entityType: 'Therapist', entityId: therapist.id, newValues: input });
    return this.get(therapist.id);
  }

  async update(id: string, input: Partial<TherapistInput>) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.get(id);
    await this.validate({ ...input, commissionType: input.commissionType, commissionTiers: input.commissionTiers ?? (before.commissionTiers as never) });
    const { serviceIds, commissionTiers, joiningDate, ...data } = input;
    await this.db.$transaction(async (tx) => {
      await tx.therapist.update({
        where: { id },
        data: {
          ...data,
          joiningDate: joiningDate ? dateOnly(joiningDate) : undefined,
          commissionTiers: commissionTiers as Prisma.InputJsonValue | undefined,
        },
      });
      if (serviceIds) {
        await tx.therapistService.deleteMany({ where: { therapistId: id } });
        if (serviceIds.length) await tx.therapistService.createMany({ data: serviceIds.map((serviceId) => ({ therapistId: id, serviceId, tenantId })) });
      }
    });
    const commissionChanged = input.commissionType !== undefined || input.commissionValue !== undefined || commissionTiers !== undefined;
    await this.audit.log({
      action: commissionChanged ? 'COMMISSION_CONFIG_CHANGED' : 'THERAPIST_UPDATED',
      entityType: 'Therapist',
      entityId: id,
      oldValues: { name: before.name, status: before.status, commissionType: before.commissionType, commissionValue: before.commissionValue },
      newValues: input,
    });
    return this.get(id);
  }

  async setSchedule(id: string, input: ScheduleInput) {
    const tenantId = RequestContext.requireTenantId();
    await this.get(id);
    const branchIds = [...new Set(input.schedules.map((s) => s.branchId))];
    branchIds.forEach((b) => RequestContext.assertBranch(b));
    if (branchIds.length) {
      const count = await this.db.branch.count({ where: { id: { in: branchIds } } });
      if (count !== branchIds.length) throw AppError.notFound('Branch');
    }
    // A therapist cannot be scheduled in two places at once.
    const byDay = new Map<number, Window[]>();
    for (const s of input.schedules) {
      const w = { start: toMinutes(s.startTime), end: toMinutes(s.endTime) };
      const list = byDay.get(s.dayOfWeek) ?? [];
      if (list.some((o) => w.start < o.end && o.start < w.end)) {
        throw AppError.invalidState('Schedule has overlapping shifts on the same day.');
      }
      list.push(w);
      byDay.set(s.dayOfWeek, list);
    }
    await this.db.$transaction(async (tx) => {
      await tx.therapistSchedule.deleteMany({ where: { therapistId: id } });
      if (input.schedules.length) {
        await tx.therapistSchedule.createMany({ data: input.schedules.map((s) => ({ ...s, tenantId, therapistId: id })) });
      }
    });
    await this.audit.log({ action: 'THERAPIST_SCHEDULE_CHANGED', entityType: 'Therapist', entityId: id, newValues: input });
    return this.get(id);
  }

  async listExceptions(id: string, from?: string, to?: string) {
    await this.get(id);
    return this.db.therapistScheduleException.findMany({
      where: {
        therapistId: id,
        date: { gte: from ? dateOnly(from) : undefined, lte: to ? dateOnly(to) : undefined },
      },
      orderBy: { date: 'asc' },
    });
  }

  async addException(id: string, input: ExceptionInput) {
    const tenantId = RequestContext.requireTenantId();
    await this.get(id);
    if (input.branchId) RequestContext.assertBranch(input.branchId);
    if ((input.startTime && !input.endTime) || (!input.startTime && input.endTime)) {
      throw AppError.validation('Provide both start and end time, or neither for a full day.');
    }
    if (input.startTime && input.endTime && input.startTime >= input.endTime) throw AppError.validation('End time must be after start time.');
    if (input.type === 'SPECIAL_SHIFT' && (!input.startTime || !input.branchId)) {
      throw AppError.validation('A special shift needs a branch, start and end time.');
    }
    const ex = await this.db.therapistScheduleException.create({
      data: { ...input, tenantId, therapistId: id, date: dateOnly(input.date) },
    });
    await this.audit.log({ action: 'THERAPIST_EXCEPTION_ADDED', entityType: 'Therapist', entityId: id, newValues: input });
    return ex;
  }

  async removeException(id: string, exceptionId: string) {
    const ex = await this.db.therapistScheduleException.findFirst({ where: { id: exceptionId, therapistId: id } });
    if (!ex) throw AppError.notFound('Schedule exception');
    await this.db.therapistScheduleException.delete({ where: { id: exceptionId } });
    return { id: exceptionId };
  }

  /**
   * Working windows (minutes since local midnight) for each therapist at a branch on a date.
   * Special shifts replace the regular schedule for that day; leave/holiday/unavailable blocks
   * remove time (the full day when no times are given).
   */
  async workingWindows(branchId: string, date: string, therapistIds?: string[], client: DbOrTx = this.db) {
    const dow = dayOfWeek(date);
    const therapists = await client.therapist.findMany({
      where: { status: 'ACTIVE', ...(therapistIds ? { id: { in: therapistIds } } : {}) },
      include: {
        schedules: { where: { branchId, dayOfWeek: dow } },
        exceptions: { where: { date: dateOnly(date) } },
        services: { select: { serviceId: true } },
      },
    });
    return therapists
      .map((t) => {
        const specials = t.exceptions.filter((e) => e.type === 'SPECIAL_SHIFT' && e.branchId === branchId && e.startTime && e.endTime);
        let windows: Window[] = specials.length
          ? specials.map((e) => ({ start: toMinutes(e.startTime!), end: toMinutes(e.endTime!) }))
          : t.schedules.map((s) => ({ start: toMinutes(s.startTime), end: toMinutes(s.endTime) }));
        for (const e of t.exceptions) {
          if (e.type === 'SPECIAL_SHIFT') continue;
          if (e.branchId && e.branchId !== branchId) continue;
          windows = e.startTime && e.endTime ? subtractWindow(windows, { start: toMinutes(e.startTime), end: toMinutes(e.endTime) }) : [];
        }
        return {
          therapistId: t.id,
          name: t.name,
          color: t.color,
          serviceIds: t.services.map((s) => s.serviceId),
          windows: windows.sort((a, b) => a.start - b.start),
        };
      })
      .filter((t) => t.windows.length);
  }
}
