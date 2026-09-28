import { Injectable } from '@nestjs/common';
import { ExpenseCategory, Prisma } from '@prisma/client';
import { ExpenseInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { LEDGER } from '../ledger/ledger.accounts';
import { LedgerService, paymentAccount } from '../ledger/ledger.service';

type ExpenseRow = { id: string; branchId: string; amount: Prisma.Decimal | number; category: string; paymentMethod: string; expenseDate: Date; vendor: string | null };

@Injectable()
export class ExpensesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async list(q: { page: number; pageSize: number; branchId?: string; category?: string; from?: string; to?: string; search?: string }) {
    const where: Prisma.ExpenseWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.category) where.category = { in: q.category.split(',') as ExpenseCategory[] };
    if (q.from || q.to) where.expenseDate = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) };
    if (q.search) where.OR = [{ description: { contains: q.search, mode: 'insensitive' } }, { vendor: { contains: q.search, mode: 'insensitive' } }];
    const [items, total, byCategory] = await Promise.all([
      this.db.expense.findMany({ where, include: { branch: { select: { id: true, name: true } } }, orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.expense.count({ where }),
      this.db.expense.groupBy({ by: ['category'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const purchaseLinked = new Set(
      (await this.db.purchase.findMany({ where: { expenseId: { in: items.map((i) => i.id) } }, select: { expenseId: true } })).map((p) => p.expenseId),
    );
    const result = paged(
      items.map((e) => ({ ...e, fromPurchase: purchaseLinked.has(e.id) })),
      total,
      q,
    );
    const categories = byCategory.map((c) => ({ category: c.category, amount: num(c._sum.amount), count: c._count._all })).sort((a, b) => b.amount - a.amount);
    Object.assign(result.meta, { summary: { total: round2(categories.reduce((s, c) => s + c.amount, 0)), byCategory: categories } });
    return result;
  }

  async get(id: string) {
    const e = await this.db.expense.findFirst({ where: { id }, include: { branch: { select: { id: true, name: true } } } });
    if (!e) throw AppError.notFound('Expense');
    RequestContext.assertBranch(e.branchId);
    return e;
  }

  private post(tx: DbOrTx, e: ExpenseRow) {
    const amount = num(e.amount);
    return this.ledger.post(tx, {
      branchId: e.branchId,
      referenceType: 'EXPENSE',
      referenceId: e.id,
      description: `${e.category.toLowerCase()} expense${e.vendor ? ` (${e.vendor})` : ''}`,
      entryDate: e.expenseDate,
      lines: [
        { code: LEDGER.OPERATING_EXPENSE, amount },
        { code: paymentAccount(e.paymentMethod), amount: -amount },
      ],
    });
  }

  private async assertEditable(id: string) {
    const linked = await this.db.purchase.findFirst({ where: { expenseId: id }, select: { id: true } });
    if (linked) throw AppError.invalidState('This expense was created by a stock purchase and cannot be changed here.');
  }

  async create(input: ExpenseInput) {
    RequestContext.assertBranch(input.branchId);
    const tenantId = RequestContext.requireTenantId();
    const e = await this.db.$transaction(async (tx) => {
      const row = await tx.expense.create({
        data: { ...input, tenantId, category: input.category as ExpenseCategory, expenseDate: dateOnly(input.expenseDate), createdBy: RequestContext.userId ?? null },
      });
      await this.post(tx, row);
      await this.events.publish(DomainEvents.EXPENSE_RECORDED, { expenseId: row.id, branchId: row.branchId, category: row.category, amount: num(row.amount) }, tx);
      return row;
    });
    await this.audit.log({ action: 'EXPENSE_CREATED', entityType: 'Expense', entityId: e.id, newValues: input });
    return this.get(e.id);
  }

  async update(id: string, input: Partial<ExpenseInput>) {
    const before = await this.get(id);
    await this.assertEditable(id);
    if (input.branchId) RequestContext.assertBranch(input.branchId);
    await this.db.$transaction(async (tx) => {
      const row = await tx.expense.update({
        where: { id },
        data: { ...input, category: input.category as ExpenseCategory | undefined, expenseDate: input.expenseDate ? dateOnly(input.expenseDate) : undefined },
      });
      // Re-post rather than edit: the ledger stays append-only and the correction is visible.
      await this.ledger.reverse(tx, 'EXPENSE', id, 'Expense corrected');
      await this.post(tx, row);
    });
    await this.audit.log({ action: 'EXPENSE_UPDATED', entityType: 'Expense', entityId: id, oldValues: { amount: before.amount, category: before.category, expenseDate: before.expenseDate }, newValues: input });
    return this.get(id);
  }

  async remove(id: string) {
    const before = await this.get(id);
    await this.assertEditable(id);
    await this.db.$transaction(async (tx) => {
      await this.ledger.reverse(tx, 'EXPENSE', id, 'Expense deleted');
      await tx.expense.delete({ where: { id } });
    });
    await this.audit.log({ action: 'EXPENSE_DELETED', entityType: 'Expense', entityId: id, oldValues: { amount: before.amount, category: before.category, expenseDate: before.expenseDate } });
    return { deleted: true };
  }
}
