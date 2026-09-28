import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  franchiseContractSchema,
  franchiseContractUpdateSchema,
  franchiseeSchema,
  franchiseeUpdateSchema,
  franchiseFeeQuery,
  franchiseGroupSchema,
} from '@therapyos/validation';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { paged } from '../../common/utils/pagination';
import { dateOnly } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';

type GroupInput = z.infer<typeof franchiseGroupSchema>;
type FranchiseeInput = z.infer<typeof franchiseeSchema>;
type ContractInput = z.infer<typeof franchiseContractSchema>;

/** Royalties are due this many days after the period closes. */
const FEE_DUE_DAYS = 15;

@Injectable()
export class FranchiseService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ---------- groups ----------

  async groups() {
    const groups = await this.db.franchiseGroup.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { franchisees: true } } } });
    return groups.map(({ _count, ...g }) => ({ ...g, franchisees: _count.franchisees }));
  }

  async createGroup(input: GroupInput) {
    const g = await this.db.franchiseGroup.create({ data: { ...input, tenantId: RequestContext.requireTenantId() } });
    await this.audit.log({ action: 'FRANCHISE_GROUP_CREATED', entityType: 'FranchiseGroup', entityId: g.id, newValues: input });
    return g;
  }

  async updateGroup(id: string, input: Partial<GroupInput>) {
    const before = await this.db.franchiseGroup.findFirst({ where: { id } });
    if (!before) throw AppError.notFound('Franchise group');
    const g = await this.db.franchiseGroup.update({ where: { id }, data: input });
    await this.audit.log({ action: 'FRANCHISE_GROUP_UPDATED', entityType: 'FranchiseGroup', entityId: id, oldValues: before, newValues: input });
    return g;
  }

  // ---------- franchisees ----------

  async list() {
    const [franchisees, dues] = await Promise.all([
      this.db.franchisee.findMany({
        orderBy: { name: 'asc' },
        include: {
          group: { select: { id: true, name: true } },
          branches: { include: { branch: { select: { id: true, name: true, code: true } } } },
          contracts: { where: { status: 'ACTIVE' }, orderBy: { startDate: 'desc' }, take: 1 },
        },
      }),
      this.db.franchiseFee.groupBy({ by: ['franchiseeId'], where: { status: 'DUE' }, _sum: { amount: true } }),
    ]);
    const due = new Map(dues.map((d) => [d.franchiseeId, num(d._sum.amount)]));
    return franchisees.map((f) => ({
      ...f,
      branches: f.branches.map((b) => b.branch),
      activeContract: f.contracts[0] ?? null,
      contracts: undefined,
      outstanding: round2(due.get(f.id) ?? 0),
    }));
  }

  async get(id: string) {
    const f = await this.db.franchisee.findFirst({
      where: { id },
      include: {
        group: { select: { id: true, name: true } },
        branches: { include: { branch: { select: { id: true, name: true, code: true, city: true } } } },
        contracts: { orderBy: { startDate: 'desc' } },
        fees: { orderBy: [{ periodStart: 'desc' }, { type: 'asc' }], take: 36 },
      },
    });
    if (!f) throw AppError.notFound('Franchisee');
    const tz = await this.settings.timezone(RequestContext.requireTenantId());
    const now = DateTime.now().setZone(tz);
    const branchIds = f.branches.map((b) => b.branchId);
    const monthly = branchIds.length
      ? await this.db.$queryRaw<{ month: string; revenue: unknown }[]>`
          SELECT to_char(date_trunc('month', i."issuedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM') AS month, sum(i.total - i.tax) AS revenue
          FROM invoices i
          WHERE i."tenantId" = ${f.tenantId} AND i.status NOT IN ('CANCELLED','DRAFT') AND i."branchId" = ANY(${branchIds}::text[])
            AND i."issuedAt" >= ${now.minus({ months: 5 }).startOf('month').toJSDate()}
          GROUP BY 1 ORDER BY 1`
      : [];
    return {
      ...f,
      branches: f.branches.map((b) => b.branch),
      monthlyRevenue: monthly.map((m) => ({ month: m.month, revenue: round2(num(m.revenue as number)) })),
      outstanding: round2(f.fees.filter((x) => x.status === 'DUE').reduce((s, x) => s + num(x.amount), 0)),
    };
  }

  private async assignBranches(tx: DbOrTx, tenantId: string, franchiseeId: string, branchIds: string[]) {
    if (branchIds.length) {
      const branches = await tx.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true } });
      if (branches.length !== new Set(branchIds).size) throw AppError.notFound('Branch');
      const taken = await tx.franchiseBranch.findMany({ where: { branchId: { in: branchIds }, franchiseeId: { not: franchiseeId } }, include: { branch: { select: { name: true } } } });
      if (taken.length) throw AppError.conflict(`${taken.map((t) => t.branch.name).join(', ')} already belongs to another franchisee.`);
    }
    await tx.franchiseBranch.deleteMany({ where: { franchiseeId, branchId: { notIn: branchIds } } });
    const existing = new Set((await tx.franchiseBranch.findMany({ where: { franchiseeId }, select: { branchId: true } })).map((b) => b.branchId));
    const add = branchIds.filter((b) => !existing.has(b));
    if (add.length) await tx.franchiseBranch.createMany({ data: add.map((branchId) => ({ tenantId, franchiseeId, branchId })) });
  }

  async create(input: FranchiseeInput) {
    const tenantId = RequestContext.requireTenantId();
    const group = await this.db.franchiseGroup.findFirst({ where: { id: input.franchiseGroupId } });
    if (!group) throw AppError.notFound('Franchise group');
    const { branchIds, ...data } = input;
    const f = await this.db.$transaction(async (tx) => {
      const created = await tx.franchisee.create({ data: { ...data, tenantId } });
      await this.assignBranches(tx, tenantId, created.id, branchIds);
      return created;
    });
    await this.audit.log({ action: 'FRANCHISEE_CREATED', entityType: 'Franchisee', entityId: f.id, newValues: input });
    return this.get(f.id);
  }

  async update(id: string, input: z.infer<typeof franchiseeUpdateSchema>) {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.db.franchisee.findFirst({ where: { id } });
    if (!before) throw AppError.notFound('Franchisee');
    const { branchIds, ...data } = input;
    await this.db.$transaction(async (tx) => {
      await tx.franchisee.update({ where: { id }, data });
      if (branchIds) await this.assignBranches(tx, tenantId, id, branchIds);
    });
    await this.audit.log({ action: 'FRANCHISEE_UPDATED', entityType: 'Franchisee', entityId: id, oldValues: before, newValues: input });
    return this.get(id);
  }

  // ---------- contracts ----------

  async createContract(input: ContractInput) {
    const tenantId = RequestContext.requireTenantId();
    const f = await this.db.franchisee.findFirst({ where: { id: input.franchiseeId } });
    if (!f) throw AppError.notFound('Franchisee');
    if (input.endDate && input.endDate < input.startDate) throw AppError.validation('The contract cannot end before it starts.');
    const contract = await this.db.$transaction(async (tx) => {
      if (input.status === 'ACTIVE') {
        await tx.franchiseContract.updateMany({ where: { franchiseeId: input.franchiseeId, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
      }
      const c = await tx.franchiseContract.create({
        data: { ...input, tenantId, startDate: dateOnly(input.startDate), endDate: input.endDate ? dateOnly(input.endDate) : null },
      });
      if (input.franchiseFee > 0) {
        const start = DateTime.fromISO(input.startDate);
        await tx.franchiseFee.create({
          data: {
            tenantId,
            franchiseeId: input.franchiseeId,
            contractId: c.id,
            type: 'FRANCHISE_FEE',
            periodStart: dateOnly(input.startDate),
            periodEnd: dateOnly(input.startDate),
            amount: input.franchiseFee,
            dueDate: dateOnly(start.plus({ days: FEE_DUE_DAYS }).toISODate()!),
          },
        });
      }
      return c;
    });
    await this.audit.log({ action: 'FRANCHISE_CONTRACT_CREATED', entityType: 'FranchiseContract', entityId: contract.id, newValues: input });
    return contract;
  }

  async updateContract(id: string, input: z.infer<typeof franchiseContractUpdateSchema>) {
    const before = await this.db.franchiseContract.findFirst({ where: { id } });
    if (!before) throw AppError.notFound('Contract');
    const { startDate, endDate, ...rest } = input;
    const c = await this.db.franchiseContract.update({
      where: { id },
      data: { ...rest, ...(startDate ? { startDate: dateOnly(startDate) } : {}), ...(endDate !== undefined ? { endDate: endDate ? dateOnly(endDate) : null } : {}) },
    });
    await this.audit.log({ action: 'FRANCHISE_CONTRACT_UPDATED', entityType: 'FranchiseContract', entityId: id, oldValues: before, newValues: input });
    return c;
  }

  // ---------- fees & royalties ----------

  async fees(q: z.infer<typeof franchiseFeeQuery>) {
    const where: Prisma.FranchiseFeeWhereInput = {};
    if (q.franchiseeId) where.franchiseeId = q.franchiseeId;
    if (q.status) where.status = q.status;
    if (q.type) where.type = q.type;
    if (q.period) where.periodStart = dateOnly(`${q.period}-01`);
    const today = dateOnly(DateTime.now().toISODate()!);
    const [items, total, byStatus, overdue] = await Promise.all([
      this.db.franchiseFee.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { franchiseeId: 'asc' }, { type: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { franchisee: { select: { id: true, name: true } } },
      }),
      this.db.franchiseFee.count({ where }),
      this.db.franchiseFee.groupBy({ by: ['status'], where, _sum: { amount: true }, _count: { _all: true } }),
      this.db.franchiseFee.aggregate({ where: { ...where, status: 'DUE', dueDate: { lt: today } }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const result = paged(
      items.map((f) => ({ ...f, overdue: f.status === 'DUE' && f.dueDate < today })),
      total,
      q,
    );
    const s = (k: string) => byStatus.find((b) => b.status === k);
    Object.assign(result.meta, {
      summary: {
        due: round2(num(s('DUE')?._sum.amount)),
        paid: round2(num(s('PAID')?._sum.amount)),
        waived: round2(num(s('WAIVED')?._sum.amount)),
        overdue: round2(num(overdue._sum.amount)),
        overdueCount: overdue._count._all,
      },
    });
    return result;
  }

  async setFeeStatus(id: string, status: 'DUE' | 'PAID' | 'WAIVED') {
    const fee = await this.db.franchiseFee.findFirst({ where: { id } });
    if (!fee) throw AppError.notFound('Fee');
    const updated = await this.db.franchiseFee.update({ where: { id }, data: { status, paidAt: status === 'PAID' ? new Date() : null } });
    await this.audit.log({ action: 'FRANCHISE_FEE_UPDATED', entityType: 'FranchiseFee', entityId: id, oldValues: { status: fee.status }, newValues: { status } });
    return updated;
  }

  /**
   * Calculates royalty, marketing and fixed fees for every contract active during `month` (YYYY-MM)
   * from the net sales (ex tax) of the franchisee's branches. Idempotent per contract/type/period;
   * existing fees are recalculated only while still DUE.
   */
  async runRoyalties(month: string) {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const start = DateTime.fromISO(`${month}-01`, { zone: tz }).startOf('month');
    if (!start.isValid) throw AppError.validation('Use a month like 2026-08.');
    const end = start.endOf('month');
    if (start > DateTime.now().setZone(tz)) throw AppError.validation('That month has not started yet.');
    const periodStart = dateOnly(start.toISODate()!);
    const periodEnd = dateOnly(end.toISODate()!);
    const dueDate = dateOnly(end.plus({ days: FEE_DUE_DAYS }).toISODate()!);

    const contracts = await this.db.franchiseContract.findMany({
      where: { status: 'ACTIVE', startDate: { lte: periodEnd }, OR: [{ endDate: null }, { endDate: { gte: periodStart } }] },
      include: { franchisee: { include: { branches: { select: { branchId: true } } } } },
    });
    let created = 0;
    let updated = 0;
    let gross = 0;
    const lines: { franchisee: string; grossRevenue: number; royalty: number; marketing: number; fixed: number }[] = [];
    for (const c of contracts) {
      const branchIds = c.franchisee.branches.map((b) => b.branchId);
      const [row] = branchIds.length
        ? await this.db.$queryRaw<{ revenue: unknown }[]>`
            SELECT coalesce(sum(i.total - i.tax),0) AS revenue FROM invoices i
            WHERE i."tenantId" = ${tenantId} AND i.status NOT IN ('CANCELLED','DRAFT') AND i."branchId" = ANY(${branchIds}::text[])
              AND i."issuedAt" BETWEEN ${start.toJSDate()} AND ${end.toJSDate()}`
        : [{ revenue: 0 }];
      const revenue = round2(num(row.revenue as number));
      gross += revenue;
      const amounts = {
        ROYALTY: round2((revenue * num(c.royaltyPercent)) / 100),
        MARKETING: round2((revenue * num(c.marketingFeePercent)) / 100),
        FIXED: round2(num(c.fixedMonthlyFee)),
      } as const;
      for (const [type, amount] of Object.entries(amounts) as [keyof typeof amounts, number][]) {
        if (amount <= 0) continue;
        const existing = await this.db.franchiseFee.findUnique({ where: { contractId_type_periodStart: { contractId: c.id, type, periodStart } } });
        if (!existing) {
          await this.db.franchiseFee.create({ data: { tenantId, franchiseeId: c.franchiseeId, contractId: c.id, type, periodStart, periodEnd, grossRevenue: revenue, amount, dueDate } });
          created++;
        } else if (existing.status === 'DUE' && (num(existing.amount) !== amount || num(existing.grossRevenue) !== revenue)) {
          await this.db.franchiseFee.update({ where: { id: existing.id }, data: { grossRevenue: revenue, amount } });
          updated++;
        }
      }
      lines.push({ franchisee: c.franchisee.name, grossRevenue: revenue, royalty: amounts.ROYALTY, marketing: amounts.MARKETING, fixed: amounts.FIXED });
    }
    await this.audit.log({ action: 'ROYALTIES_CALCULATED', entityType: 'FranchiseFee', newValues: { month, contracts: contracts.length, created, updated } });
    return { month, contracts: contracts.length, created, updated, grossRevenue: round2(gross), lines };
  }

  /** Daily-job hook: from the 1st of each month, bill the month that just closed. */
  async runPreviousMonth() {
    const tz = await this.settings.timezone(RequestContext.requireTenantId());
    const month = DateTime.now().setZone(tz).minus({ months: 1 }).toFormat('yyyy-LL');
    const hasContracts = await this.db.franchiseContract.count({ where: { status: 'ACTIVE' } });
    if (!hasContracts) return { skipped: 'no active contracts' };
    return this.runRoyalties(month);
  }

  async overview() {
    const tenantId = RequestContext.requireTenantId();
    const tz = await this.settings.timezone(tenantId);
    const now = DateTime.now().setZone(tz);
    const monthStart = now.startOf('month');
    const [franchisees, branches, dues, paidThisYear, mtd] = await Promise.all([
      this.db.franchisee.count({ where: { status: 'ACTIVE' } }),
      this.db.franchiseBranch.count(),
      this.db.franchiseFee.aggregate({ where: { status: 'DUE' }, _sum: { amount: true } }),
      this.db.franchiseFee.aggregate({ where: { status: 'PAID', paidAt: { gte: now.startOf('year').toJSDate() } }, _sum: { amount: true } }),
      this.db.$queryRaw<{ revenue: unknown }[]>`
        SELECT coalesce(sum(i.total - i.tax),0) AS revenue FROM invoices i JOIN franchise_branches fb ON fb."branchId" = i."branchId"
        WHERE i."tenantId" = ${tenantId} AND i.status NOT IN ('CANCELLED','DRAFT') AND i."issuedAt" >= ${monthStart.toJSDate()}`,
    ]);
    return {
      franchisees,
      branches,
      outstanding: round2(num(dues._sum.amount)),
      collectedThisYear: round2(num(paidThisYear._sum.amount)),
      franchiseRevenueMtd: round2(num(mtd[0]?.revenue as number)),
      lastClosedMonth: now.minus({ months: 1 }).toFormat('yyyy-LL'),
    };
  }
}
