import { timingSafeEqual } from 'crypto';

/** Constant-time string comparison for secrets, signatures and credentials. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
