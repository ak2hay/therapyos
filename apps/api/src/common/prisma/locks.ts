import type { DbOrTx } from './prisma.service';

/**
 * Transaction-scoped Postgres advisory lock. Serialises concurrent writers on the same logical
 * resource (therapist calendar, queue token counter, invoice sequence) until commit/rollback.
 */
export async function advisoryLock(tx: DbOrTx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
