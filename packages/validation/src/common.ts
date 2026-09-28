import { z } from 'zod';

export const id = z.string().min(1).max(64);
export const optionalId = id.optional().nullable();
export const money = z.coerce.number().min(0).max(100_000_000);
export const percent = z.coerce.number().min(0).max(100);
export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number');
export const email = z.string().trim().toLowerCase().email();
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });
export const recordStatus = z.enum(['ACTIVE', 'INACTIVE']);

export const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

/** Query-string boolean: only "true"/"false" (or real booleans) are accepted; `z.coerce.boolean` treats "false" as true. */
export const queryBool = z.preprocess(
  (v) => (v === 'true' || v === true || v === '1' ? true : v === 'false' || v === false || v === '0' ? false : undefined),
  z.boolean().optional(),
);

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const dateRangeQuery = z.object({
  preset: z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'custom']).default('this_month'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: z.string().optional(),
  serviceId: z.string().optional(),
  therapistId: z.string().optional(),
  paymentMethod: z.string().optional(),
  customerType: z.enum(['new', 'returning']).optional(),
  packageId: z.string().optional(),
  membershipPlanId: z.string().optional(),
});
export type DateRangeQuery = z.infer<typeof dateRangeQuery>;
