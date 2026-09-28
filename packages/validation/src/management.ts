import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '@therapyos/types';
import { emptyToUndefined, id, isoDate, money, paginationQuery, queryBool } from './common';

const outflowMethod = z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER']);

export const stockAdjustSchema = z.object({
  branchId: id,
  productId: id,
  type: z.enum(['ADJUSTMENT', 'DAMAGE', 'RETURN', 'CONSUMPTION']),
  quantity: z.coerce.number().refine((v) => v !== 0, 'Quantity cannot be zero'),
  notes: emptyToUndefined(z.string().max(300)),
});
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;

export const reorderLevelSchema = z.object({ branchId: id, productId: id, reorderLevel: z.coerce.number().min(0) });

export const purchaseSchema = z.object({
  branchId: id,
  supplierName: z.string().trim().min(1).max(120),
  referenceNumber: emptyToUndefined(z.string().max(60)),
  purchasedAt: emptyToUndefined(isoDate),
  paymentMethod: outflowMethod.default('CASH'),
  recordExpense: z.boolean().default(true),
  items: z
    .array(z.object({ productId: id, quantity: z.coerce.number().positive(), unitCost: money }))
    .min(1),
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const transferSchema = z
  .object({
    fromBranchId: id,
    toBranchId: id,
    notes: emptyToUndefined(z.string().max(300)),
    items: z.array(z.object({ productId: id, quantity: z.coerce.number().positive() })).min(1),
  })
  .refine((t) => t.fromBranchId !== t.toBranchId, 'Source and destination must differ');
export type TransferInput = z.infer<typeof transferSchema>;

export const inventoryQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  categoryId: z.string().optional(),
  lowStock: queryBool,
});

export const productQuery = z.object({
  search: z.string().trim().max(100).optional(),
  categoryId: z.string().optional(),
  branchId: z.string().optional(),
  consumable: queryBool,
  retail: queryBool,
  all: queryBool,
});

export const inventoryTxnQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  productId: z.string().optional(),
  type: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const transferQuery = paginationQuery.extend({ status: z.string().optional(), branchId: z.string().optional() });
export const purchaseQuery = paginationQuery.extend({ branchId: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() });

export const expenseSchema = z.object({
  branchId: id,
  category: z.enum(EXPENSE_CATEGORIES as [string, ...string[]]),
  amount: money.refine((v) => v > 0, 'Amount must be positive'),
  description: emptyToUndefined(z.string().max(500)),
  expenseDate: isoDate,
  paymentMethod: outflowMethod.default('CASH'),
  vendor: emptyToUndefined(z.string().max(120)),
  receiptUrl: emptyToUndefined(z.string().url()),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseQuery = paginationQuery.extend({
  branchId: z.string().optional(),
  category: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const reportQuery = z.object({
  from: isoDate,
  to: isoDate,
  branchId: z.string().optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});
export type ReportQuery = z.infer<typeof reportQuery>;

export const reportExportQuery = reportQuery.extend({ format: z.enum(['csv', 'xlsx', 'pdf']).default('csv') });
