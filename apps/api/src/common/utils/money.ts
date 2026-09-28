import { Prisma } from '@prisma/client';

export type Numeric = number | string | Prisma.Decimal | null | undefined;

/** Converts Prisma Decimals / strings to a JS number (money values fit comfortably in doubles). */
export const num = (v: Numeric): number => (v === null || v === undefined ? 0 : Number(v));

/** Rounds half-up to 2 decimals, avoiding binary float artefacts. */
export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export const sum = (values: Numeric[]): number => round2(values.reduce<number>((acc, v) => acc + num(v), 0));

export const pct = (amount: number, percent: number): number => round2((amount * percent) / 100);

export type RoundingMode = 'NONE' | 'NEAREST_1' | 'NEAREST_5' | 'NEAREST_10';

export function applyRounding(total: number, mode: RoundingMode = 'NEAREST_1'): { total: number; rounding: number } {
  const step = mode === 'NEAREST_1' ? 1 : mode === 'NEAREST_5' ? 5 : mode === 'NEAREST_10' ? 10 : 0;
  if (!step) return { total: round2(total), rounding: 0 };
  const rounded = Math.round(total / step) * step;
  return { total: round2(rounded), rounding: round2(rounded - total) };
}
