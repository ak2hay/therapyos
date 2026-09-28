import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { dateOnly } from '../common/utils/dates';
import { DomainEvents, EventsService } from '../core/events.service';
import { AppointmentsService } from '../modules/appointments/appointments.service';
import { CustomersService } from '../modules/customers/customers.service';
import { QueueService } from '../modules/queue/queue.service';
import type { DemoContext } from './demo';

const logger = new Logger('SeedDemo');

/** Deterministic PRNG so the demo dataset is reproducible. */
export function rng(seed: number) {
  let a = seed;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
  };
}

const FIRST = ['Aarav', 'Aditi', 'Akash', 'Ananya', 'Arjun', 'Bhavna', 'Chetan', 'Divya', 'Esha', 'Gaurav', 'Isha', 'Karan', 'Kiran', 'Lavanya', 'Manish', 'Neha', 'Nikhil', 'Pooja', 'Rajesh', 'Ritu', 'Rohan', 'Sanjana', 'Shreya', 'Siddharth', 'Sneha', 'Tanvi', 'Varun', 'Vidya', 'Yash', 'Zara', 'Harsh', 'Meghna', 'Naveen', 'Pallavi', 'Rakesh', 'Swati'];
const LAST = ['Agarwal', 'Bhat', 'Chopra', 'Desai', 'Gupta', 'Hegde', 'Iyer', 'Jain', 'Kapoor', 'Kulkarni', 'Mehta', 'Nair', 'Patel', 'Rao', 'Reddy', 'Saxena', 'Shetty', 'Sinha', 'Srinivasan', 'Thomas'];
const SOURCES = ['WALK_IN', 'WALK_IN', 'REFERRAL', 'INSTAGRAM', 'GOOGLE', 'WEBSITE', 'WHATSAPP', 'CAMPAIGN'] as const;
const NOTES = ['Client preferred medium pressure.', 'Tension in lower back, focused there.', 'Recommended follow-up in 2 weeks.', 'Sensitive to strong aromas.', 'Shoulder stiffness improved.', 'Client fell asleep, very relaxed.', ''];

type Profile = 'loyal' | 'regular' | 'onetime' | 'churned' | 'lapsed' | 'new';
const PROFILES: Array<[Profile, number]> = [
  ['loyal', 14],
  ['regular', 16],
  ['onetime', 14],
  ['lapsed', 6],
  ['churned', 6],
  ['new', 4],
];

export async function seedOperations(ctx: DemoContext) {
  const { db, tenantId, app } = ctx;
  const r = rng(20260927);
  const customersService = app.get(CustomersService);
  const events = app.get(EventsService);
  const tz = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone ?? 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);

  const branches = await db.branch.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  const services = await db.service.findMany({ where: { tenantId, status: 'ACTIVE' }, include: { branchServices: true } });
  const therapists = await db.therapist.findMany({ where: { tenantId, status: 'ACTIVE' }, include: { services: true, schedules: true } });
  const priceAt = (serviceId: string, branchId: string) => {
    const s = services.find((x) => x.id === serviceId)!;
    const o = s.branchServices.find((b) => b.branchId === branchId);
    if (o && !o.isActive) return null;
    return { price: Number(o?.price ?? s.basePrice), duration: o?.durationMinutes ?? s.durationMinutes };
  };

  // Customers with behaviour profiles that drive their visit history.
  const customers: Array<{ id: string; profile: Profile; branchId: string; createdAt: DateTime }> = [];
  let n = 0;
  for (const [profile, count] of PROFILES) {
    for (let i = 0; i < count; i++) {
      n++;
      const name = `${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 3) % LAST.length]}`;
      const branch = n % 3 === 0 ? branches[1] : branches[0];
      const referrer = customers.length > 5 && r.chance(0.15) ? r.pick(customers).id : undefined;
      const phone = `+9198450${String(10000 + n).slice(-5)}`;
      const c = (await db.customer.findFirst({ where: { phone } })) ?? await customersService.create({
        name,
        phone,
        email: r.chance(0.7) ? `${name.toLowerCase().replace(/\s+/g, '.')}${n}@example.com` : undefined,
        gender: r.pick(['MALE', 'FEMALE', 'FEMALE'] as const),
        dob: r.chance(0.6) ? `${r.int(1965, 2002)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}` : undefined,
        city: 'Bengaluru',
        source: referrer ? 'REFERRAL' : r.pick(SOURCES),
        primaryBranchId: branch.id,
        referredById: referrer,
        marketingOptIn: r.chance(0.6),
        whatsappOptIn: true,
        tags: profile === 'loyal' && r.chance(0.5) ? ['regular'] : [],
      });
      const createdAt = profile === 'new' ? now.minus({ days: r.int(0, 10) }) : now.minus({ days: r.int(120, 200) });
      await db.customer.update({ where: { id: c.id }, data: { createdAt: createdAt.toJSDate() } });
      await db.customerActivity.updateMany({ where: { customerId: c.id, type: 'CUSTOMER_CREATED' }, data: { occurredAt: createdAt.toJSDate() } });
      customers.push({ id: c.id, profile, branchId: branch.id, createdAt });
    }
  }
  // A birthday this week makes the retention automation demo-able.
  await db.customer.update({ where: { id: customers[0].id }, data: { dob: dateOnly(`1990-${now.plus({ days: 2 }).toFormat('MM-dd')}`) } });

  // Visit dates (days ago) per profile.
  const visitDays = (p: Profile): number[] => {
    const days: number[] = [];
    switch (p) {
      case 'loyal':
        for (let d = r.int(160, 175); d > 2; d -= r.int(8, 18)) days.push(d);
        break;
      case 'regular':
        for (let d = r.int(150, 170); d > 5; d -= r.int(22, 40)) days.push(d);
        break;
      case 'onetime':
        days.push(r.int(3, 50));
        break;
      case 'lapsed':
        for (let d = r.int(150, 170); d > 70; d -= r.int(20, 30)) days.push(d);
        break;
      case 'churned':
        days.push(r.int(170, 179), r.int(135, 150));
        break;
      case 'new':
        break;
    }
    return days;
  };

  const busy = new Map<string, Set<number>>();
  const occupy = (therapistId: string, day: string, hour: number, hours: number) => {
    const key = `${therapistId}:${day}`;
    const set = busy.get(key) ?? new Set<number>();
    for (let h = hour; h < hour + hours; h++) if (set.has(h)) return false;
    for (let h = hour; h < hour + hours; h++) set.add(h);
    busy.set(key, set);
    return true;
  };

  let sessionsCreated = 0;
  let noShows = 0;
  let cancelled = 0;
  for (const c of customers) {
    const favourite = r.pick(services.filter((s) => priceAt(s.id, c.branchId)));
    for (const daysAgo of visitDays(c.profile)) {
      const day = now.minus({ days: daysAgo }).startOf('day');
      const iso = day.toISODate()!;
      const weekday = day.weekday % 7;
      const service = r.chance(0.6) ? favourite : r.pick(services);
      const pricing = priceAt(service.id, c.branchId);
      if (!pricing) continue;
      const candidates = therapists.filter(
        (t) => t.services.some((s) => s.serviceId === service.id) && t.schedules.some((s) => s.branchId === c.branchId && s.dayOfWeek === weekday),
      );
      if (!candidates.length) continue;
      const therapist = r.pick(candidates);
      const schedule = therapist.schedules.find((s) => s.branchId === c.branchId && s.dayOfWeek === weekday)!;
      const openH = Number(schedule.startTime.slice(0, 2));
      const closeH = Number(schedule.endTime.slice(0, 2));
      const hours = Math.ceil((pricing.duration + 10) / 60);
      let hour = -1;
      for (let attempt = 0; attempt < 6; attempt++) {
        const h = r.int(openH, Math.max(openH, closeH - hours));
        if (occupy(therapist.id, iso, h, hours)) {
          hour = h;
          break;
        }
      }
      if (hour < 0) continue;
      const start = day.set({ hour, minute: r.pick([0, 0, 30]) });
      const end = start.plus({ minutes: pricing.duration });
      const booked = r.chance(0.55);
      const outcome = booked && r.chance(0.06) ? 'NO_SHOW' : booked && r.chance(0.05) ? 'CANCELLED' : 'COMPLETED';

      const appointment = booked
        ? await db.appointment.create({
            data: {
              tenantId,
              branchId: c.branchId,
              customerId: c.id,
              serviceId: service.id,
              therapistId: therapist.id,
              appointmentDate: dateOnly(iso),
              startTime: start.toJSDate(),
              endTime: end.toJSDate(),
              status: outcome,
              source: r.pick(['RECEPTION', 'PHONE', 'WHATSAPP', 'WEBSITE'] as const),
              checkedInAt: outcome === 'COMPLETED' ? start.minus({ minutes: 5 }).toJSDate() : null,
              cancelledAt: outcome === 'CANCELLED' ? start.minus({ days: 1 }).toJSDate() : null,
              cancelReason: outcome === 'CANCELLED' ? 'Customer rescheduled' : null,
              createdAt: start.minus({ days: r.int(1, 6) }).toJSDate(),
            },
          })
        : null;
      if (outcome === 'NO_SHOW') {
        noShows++;
        await db.customerActivity.create({ data: { tenantId, customerId: c.id, branchId: c.branchId, type: 'APPOINTMENT_NO_SHOW', title: `Missed ${service.name}`, refType: 'Appointment', refId: appointment!.id, occurredAt: end.toJSDate() } });
        continue;
      }
      if (outcome === 'CANCELLED') {
        cancelled++;
        continue;
      }
      const session = await db.therapySession.create({
        data: {
          tenantId,
          branchId: c.branchId,
          customerId: c.id,
          therapistId: therapist.id,
          serviceId: service.id,
          appointmentId: appointment?.id,
          status: 'COMPLETED',
          room: `Room ${r.int(1, 5)}`,
          startedAt: start.toJSDate(),
          completedAt: end.toJSDate(),
          notes: r.pick(NOTES) || null,
          createdAt: start.toJSDate(),
        },
      });
      sessionsCreated++;
      await db.customerActivity.create({
        data: { tenantId, customerId: c.id, branchId: c.branchId, type: 'SESSION_COMPLETED', title: `${service.name} with ${therapist.name}`, refType: 'TherapySession', refId: session.id, occurredAt: end.toJSDate() },
      });
      await events.publish(DomainEvents.SESSION_COMPLETED, {
        sessionId: session.id,
        customerId: c.id,
        therapistId: therapist.id,
        serviceId: service.id,
        branchId: c.branchId,
        appointmentId: appointment?.id ?? null,
        customerPackageId: null,
        customerMembershipId: null,
        servicePrice: pricing.price,
        productsUsed: [],
        completedAt: end.toISO(),
        seeded: true,
      });
    }
  }

  // Upcoming bookings through the real booking flow (availability + conflict checks).
  const appointments = app.get(AppointmentsService);
  let upcoming = 0;
  const active = customers.filter((c) => c.profile !== 'churned');
  for (let d = 0; d <= 7; d++) {
    const day = now.plus({ days: d });
    for (const branch of branches) {
      const perDay = d === 0 ? 5 : r.int(2, 4);
      for (let i = 0; i < perDay; i++) {
        const c = r.pick(active.filter((x) => x.branchId === branch.id));
        const service = r.pick(services.filter((s) => priceAt(s.id, branch.id)));
        const minHour = d === 0 ? Math.max(now.hour + 1, Number(branch.openingTime.slice(0, 2))) : Number(branch.openingTime.slice(0, 2));
        const maxHour = Number(branch.closingTime.slice(0, 2)) - 2;
        if (minHour > maxHour) continue;
        try {
          await appointments.create(
            {
              branchId: branch.id,
              customerId: c.id,
              serviceId: service.id,
              date: day.toISODate()!,
              startTime: `${String(r.int(minHour, maxHour)).padStart(2, '0')}:${r.pick(['00', '30'])}`,
              source: r.pick(['RECEPTION', 'PHONE', 'WHATSAPP', 'WEBSITE'] as const),
              notes: r.chance(0.2) ? 'Prefers a female therapist' : undefined,
            },
            {},
          );
          upcoming++;
        } catch {
          // Slot taken or nobody free; skip.
        }
      }
    }
  }
  const confirmed = await db.appointment.findMany({ where: { tenantId, status: 'BOOKED', startTime: { gt: now.toJSDate() } }, take: 6, select: { id: true } });
  await db.appointment.updateMany({ where: { id: { in: confirmed.map((a) => a.id) } }, data: { status: 'CONFIRMED' } });

  // Two walk-ins waiting at the main branch right now.
  const queue = app.get(QueueService);
  const walkInService = services.find((s) => s.name === 'Foot Reflexology') ?? services[0];
  await queue.add({ branchId: branches[0].id, customer: { name: 'Walk-in Guest', phone: '+919845099001' }, serviceId: walkInService.id, priority: 0 });
  const regular = customers.find((c) => c.profile === 'loyal' && c.branchId === branches[0].id);
  if (regular) await queue.add({ branchId: branches[0].id, customerId: regular.id, serviceId: services[0].id, priority: 0 });

  logger.log(`Operations: ${customers.length} customers, ${sessionsCreated} completed sessions, ${noShows} no-shows, ${cancelled} cancellations, ${upcoming} upcoming bookings`);
}
