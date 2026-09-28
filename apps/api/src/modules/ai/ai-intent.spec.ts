import { DateTime, Settings } from 'luxon';
import { resolvePeriod } from './ai-period';
import { classify, SUGGESTED_QUESTIONS } from './ai.module';

describe('classify', () => {
  it('maps every suggested question to its own intent', () => {
    expect(SUGGESTED_QUESTIONS.map(classify)).toEqual(['revenue_change', 'contact_customers', 'service_trends', 'repeat_visits', 'peak_times', 'branch_attention']);
  });

  it.each([
    ['Who are my lapsed clients?', 'contact_customers'],
    ['When are we busiest on weekends?', 'peak_times'],
    ['How is customer retention?', 'repeat_visits'],
    ['Which massages sell best?', 'service_trends'],
    ['Did takings drop at Koramangala?', 'revenue_change'],
    ['Give me a summary', 'overview'],
  ])('%s -> %s', (q, intent) => {
    expect(classify(q)).toBe(intent);
  });
});

describe('resolvePeriod', () => {
  const tz = 'Asia/Kolkata';
  const fixed = DateTime.fromISO('2026-09-17T15:30:00', { zone: tz });
  const original = Settings.now;

  beforeAll(() => {
    Settings.now = () => fixed.toMillis();
  });
  afterAll(() => {
    Settings.now = original;
  });

  it('uses explicit dates and compares with the same-length window before', () => {
    const p = resolvePeriod('How was revenue?', tz, 30, '2026-09-01', '2026-09-10');
    expect(p.start.toISODate()).toBe('2026-09-01');
    expect(p.end.toISODate()).toBe('2026-09-10');
    expect(p.prevStart.toISODate()).toBe('2026-08-22');
    expect(p.prevEnd.toISODate()).toBe('2026-08-31');
    expect(p.days).toBe(10);
  });

  it('resolves "last month" to the previous calendar month named by month', () => {
    const p = resolvePeriod('Why did revenue fall last month?', tz, 30);
    expect(p.label).toBe('August');
    expect(p.start.toISODate()).toBe('2026-08-01');
    expect(p.end.toISODate()).toBe('2026-08-31');
    expect(p.prevStart.toISODate()).toBe('2026-07-01');
  });

  it('resolves "this week" to the last 7 days including today', () => {
    const p = resolvePeriod('Why did revenue fall this week?', tz, 30);
    expect(p.start.toISODate()).toBe('2026-09-11');
    expect(p.end.toISO()).toBe(fixed.toISO());
    expect(p.label).toBe('the last 7 days');
  });

  it('reads "last N days" and caps it at a year', () => {
    expect(resolvePeriod('sales in the last 14 days', tz, 30).days).toBe(14);
    expect(resolvePeriod('sales in the last 900 days', tz, 30).days).toBe(365);
  });

  it('compares month-to-date with the same days of the previous month', () => {
    const p = resolvePeriod('How is this month going?', tz, 30);
    expect(p.label).toBe('September so far');
    expect(p.prevStart.toISODate()).toBe('2026-08-01');
    expect(p.prevEnd.toISODate()).toBe('2026-08-17');
  });
});
