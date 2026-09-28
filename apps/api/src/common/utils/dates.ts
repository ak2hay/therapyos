import { DateTime } from 'luxon';
import type { DateRangeQuery } from '@therapyos/validation';

export const DEFAULT_TZ = 'Asia/Kolkata';

/** YYYY-MM-DD for "now" in a timezone. */
export function todayIn(tz = DEFAULT_TZ): string {
  return DateTime.now().setZone(tz).toISODate()!;
}

/** A Date suitable for a Postgres DATE column (UTC midnight of the given calendar date). */
export function dateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Converts a calendar date + HH:mm in a timezone to a UTC instant. */
export function zonedToUtc(isoDate: string, time: string, tz = DEFAULT_TZ): Date {
  return DateTime.fromISO(`${isoDate}T${time}`, { zone: tz }).toUTC().toJSDate();
}

export function formatInZone(d: Date, tz = DEFAULT_TZ, fmt = 'dd LLL yyyy, hh:mm a'): string {
  return DateTime.fromJSDate(d).setZone(tz).toFormat(fmt);
}

export function dayOfWeek(isoDate: string): number {
  // luxon weekday: 1 = Monday ... 7 = Sunday; we store 0 = Sunday ... 6 = Saturday
  return DateTime.fromISO(isoDate).weekday % 7;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export interface ResolvedRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  prevFrom: Date;
  prevTo: Date;
}

/** Resolves report presets (today, this_month, ...) into UTC instants for the tenant timezone. */
export function resolveRange(q: Pick<DateRangeQuery, 'preset' | 'from' | 'to'>, tz = DEFAULT_TZ): ResolvedRange {
  const now = DateTime.now().setZone(tz);
  let start: DateTime;
  let end: DateTime;
  switch (q.preset) {
    case 'today':
      start = now.startOf('day');
      end = now.endOf('day');
      break;
    case 'yesterday':
      start = now.minus({ days: 1 }).startOf('day');
      end = now.minus({ days: 1 }).endOf('day');
      break;
    case 'this_week':
      start = now.startOf('week');
      end = now.endOf('day');
      break;
    case 'last_month':
      start = now.minus({ months: 1 }).startOf('month');
      end = now.minus({ months: 1 }).endOf('month');
      break;
    case 'custom':
      start = q.from ? DateTime.fromISO(q.from, { zone: tz }).startOf('day') : now.startOf('month');
      end = q.to ? DateTime.fromISO(q.to, { zone: tz }).endOf('day') : now.endOf('day');
      break;
    case 'this_month':
    default:
      start = now.startOf('month');
      end = now.endOf('day');
  }
  const spanMs = end.toMillis() - start.toMillis();
  return {
    from: start.toUTC().toJSDate(),
    to: end.toUTC().toJSDate(),
    fromDate: start.toISODate()!,
    toDate: end.toISODate()!,
    prevFrom: new Date(start.toMillis() - spanMs - 1),
    prevTo: new Date(start.toMillis() - 1),
  };
}
