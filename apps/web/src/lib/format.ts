import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { useAuth } from './auth-store';

export function currencyCode() {
  return useAuth.getState().user?.currency ?? 'INR';
}

export function money(value: number | string | null | undefined, currency = currencyCode(), compact = false) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: compact ? 1 : 2,
    minimumFractionDigits: compact ? 0 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(n);
}

export function num(value: number | null | undefined, digits = 0) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(Number(value ?? 0));
}

const toDate = (d: string | Date) => (typeof d === 'string' ? parseISO(d) : d);

export function fmtDate(d: string | Date | null | undefined, pattern = 'dd MMM yyyy') {
  if (!d) return '-';
  return format(toDate(d), pattern);
}

export function fmtDateTime(d: string | Date | null | undefined) {
  return fmtDate(d, 'dd MMM yyyy, hh:mm a');
}

export function fmtTime(d: string | Date | null | undefined) {
  return fmtDate(d, 'hh:mm a');
}

export function ago(d: string | Date | null | undefined) {
  if (!d) return '-';
  return formatDistanceToNow(toDate(d), { addSuffix: true });
}

export function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

export function titleCase(s: string | null | undefined) {
  if (!s) return '';
  return s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
