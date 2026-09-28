import { DateTime } from 'luxon';

export interface Period {
  start: DateTime;
  end: DateTime;
  prevStart: DateTime;
  prevEnd: DateTime;
  label: string;
  prevLabel: string;
  days: number;
}

const span = (start: DateTime, end: DateTime) => Math.max(1, Math.round(end.endOf('day').diff(start.startOf('day'), 'days').days));

/** The same-length window immediately before [start, end]. */
function previousOf(start: DateTime, end: DateTime) {
  const length = end.diff(start);
  const prevEnd = start.minus({ milliseconds: 1 });
  return { prevStart: prevEnd.minus(length), prevEnd };
}

const fmt = (d: DateTime) => d.toFormat('d LLL');

/**
 * Resolves the period a question is about ("this week", "last month", "last 14 days", ...) in the tenant's
 * time zone, with the comparison period it should be measured against. Explicit dates win.
 */
export function resolvePeriod(question: string, tz: string, defaultDays: number, from?: string, to?: string): Period {
  const now = DateTime.now().setZone(tz);
  const q = question.toLowerCase();
  const make = (start: DateTime, end: DateTime, label: string, prevLabel: string, prev?: { prevStart: DateTime; prevEnd: DateTime }) => {
    const p = prev ?? previousOf(start, end);
    return { start, end, ...p, label, prevLabel, days: span(start, end) };
  };

  if (from && to) {
    const start = DateTime.fromISO(from, { zone: tz }).startOf('day');
    const end = DateTime.fromISO(to, { zone: tz }).endOf('day');
    const p = previousOf(start, end);
    return make(start, end, `${fmt(start)} – ${fmt(end)}`, `${fmt(p.prevStart)} – ${fmt(p.prevEnd)}`, p);
  }
  if (/\byesterday\b/.test(q)) {
    const d = now.minus({ days: 1 });
    return make(d.startOf('day'), d.endOf('day'), 'yesterday', 'the day before');
  }
  if (/\btoday\b/.test(q)) {
    return make(now.startOf('day'), now, 'today so far', 'the same hours yesterday', { prevStart: now.minus({ days: 1 }).startOf('day'), prevEnd: now.minus({ days: 1 }) });
  }
  if (/\blast week\b|\bprevious week\b/.test(q)) {
    const start = now.minus({ weeks: 1 }).startOf('week');
    return make(start, start.endOf('week'), 'last week', 'the week before', { prevStart: start.minus({ weeks: 1 }), prevEnd: start.minus({ weeks: 1 }).endOf('week') });
  }
  if (/\bthis week\b|\bweek\b/.test(q)) {
    const start = now.minus({ days: 6 }).startOf('day');
    return make(start, now, 'the last 7 days', 'the 7 days before');
  }
  if (/\blast month\b|\bprevious month\b/.test(q)) {
    const start = now.minus({ months: 1 }).startOf('month');
    return make(start, start.endOf('month'), start.toFormat('LLLL'), start.minus({ months: 1 }).toFormat('LLLL'), { prevStart: start.minus({ months: 1 }), prevEnd: start.minus({ months: 1 }).endOf('month') });
  }
  if (/\bthis month\b|\bmonth\b/.test(q) && !/\blast month\b/.test(q) && now.day < 7) {
    const start = now.minus({ days: 29 }).startOf('day');
    return make(start, now, 'the last 30 days', 'the 30 days before');
  }
  if (/\bthis month\b|\bmonth\b/.test(q)) {
    const start = now.startOf('month');
    const elapsed = now.diff(start);
    const prevStart = start.minus({ months: 1 });
    return make(start, now, `${now.toFormat('LLLL')} so far`, `the same days of ${prevStart.toFormat('LLLL')}`, { prevStart, prevEnd: DateTime.min(prevStart.plus(elapsed), prevStart.endOf('month')) });
  }
  if (/\bquarter\b/.test(q)) {
    const start = now.startOf('quarter');
    const elapsed = now.diff(start);
    const prevStart = start.minus({ quarters: 1 });
    return make(start, now, 'this quarter so far', 'the same part of last quarter', { prevStart, prevEnd: prevStart.plus(elapsed) });
  }
  const nDays = q.match(/\b(\d{1,3})\s*days?\b/);
  const days = nDays ? Math.min(365, Math.max(1, Number(nDays[1]))) : defaultDays;
  const start = now.minus({ days: days - 1 }).startOf('day');
  return make(start, now, `the last ${days} days`, `the ${days} days before`);
}
