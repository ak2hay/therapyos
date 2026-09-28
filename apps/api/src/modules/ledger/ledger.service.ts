import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RequestContext } from '../../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { DEFAULT_LEDGER_ACCOUNTS, LEDGER } from './ledger.accounts';

export interface JournalLine {
  code: string;
  /** Positive = debit, negative = credit. */
  amount: number;
  description?: string;
}

export interface Journal {
  branchId?: string | null;
  referenceType: string;
  referenceId: string;
  description?: string;
  entryDate?: Date;
  lines: JournalLine[];
}

const REVENUE_ACCOUNT: Record<string, string> = {
  SERVICE: LEDGER.SERVICE_REVENUE,
  PRODUCT: LEDGER.PRODUCT_REVENUE,
  // Package money is a liability until sessions are redeemed; see recognisePackageRevenue.
  PACKAGE: LEDGER.DEFERRED_REVENUE,
  MEMBERSHIP: LEDGER.MEMBERSHIP_REVENUE,
};

export function paymentAccount(method: PaymentMethod | string): string {
  switch (method) {
    case 'CASH':
      return LEDGER.CASH;
    case 'UPI':
      return LEDGER.UPI_CLEARING;
    case 'CARD':
      return LEDGER.CARD_CLEARING;
    case 'RAZORPAY':
      return LEDGER.GATEWAY_CLEARING;
    default:
      return LEDGER.BANK;
  }
}

interface InvoiceForJournal {
  id: string;
  branchId: string;
  invoiceNumber: string;
  total: Prisma.Decimal | number;
  tax: Prisma.Decimal | number;
  rounding: Prisma.Decimal | number;
  issuedAt?: Date | null;
  items: { itemType: string; total: Prisma.Decimal | number; tax: Prisma.Decimal | number; discount: Prisma.Decimal | number; meta: Prisma.JsonValue }[];
}

/**
 * Double-entry general ledger. Every money movement posts a balanced journal in the same
 * transaction as the business change, so the books can always be reconciled to invoices.
 */
@Injectable()
export class LedgerService {
  constructor(@InjectDb() private readonly db: Db) {}

  private async accountIds(client: DbOrTx, tenantId: string): Promise<Map<string, string>> {
    let rows = await client.ledgerAccount.findMany({ where: { tenantId }, select: { id: true, code: true } });
    if (rows.length < DEFAULT_LEDGER_ACCOUNTS.length) {
      const have = new Set(rows.map((r) => r.code));
      const missing = DEFAULT_LEDGER_ACCOUNTS.filter((a) => !have.has(a.code));
      if (missing.length) {
        await client.ledgerAccount.createMany({ data: missing.map((a) => ({ ...a, tenantId })), skipDuplicates: true });
        rows = await client.ledgerAccount.findMany({ where: { tenantId }, select: { id: true, code: true } });
      }
    }
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  async post(client: DbOrTx, j: Journal) {
    const tenantId = RequestContext.requireTenantId();
    const merged = new Map<string, number>();
    for (const l of j.lines) merged.set(l.code, round2((merged.get(l.code) ?? 0) + l.amount));
    const lines = [...merged.entries()].filter(([, amount]) => Math.abs(amount) >= 0.005);
    if (!lines.length) return null;
    const balance = round2(lines.reduce((s, [, a]) => s + a, 0));
    if (Math.abs(balance) >= 0.01) throw new Error(`Unbalanced journal for ${j.referenceType} ${j.referenceId}: ${balance}`);
    const ids = await this.accountIds(client, tenantId);
    const journalId = randomUUID();
    await client.ledgerEntry.createMany({
      data: lines.map(([code, amount]) => ({
        tenantId,
        branchId: j.branchId ?? null,
        journalId,
        accountId: ids.get(code)!,
        debit: amount > 0 ? amount : 0,
        credit: amount < 0 ? -amount : 0,
        referenceType: j.referenceType,
        referenceId: j.referenceId,
        description: j.description,
        entryDate: j.entryDate ?? new Date(),
      })),
    });
    return journalId;
  }

  /** Receivable for the invoice total against net revenue, tax and rounding; discounts are shown gross. */
  invoiceIssued(client: DbOrTx, inv: InvoiceForJournal) {
    const lines: JournalLine[] = [{ code: LEDGER.RECEIVABLES, amount: num(inv.total) }];
    for (const item of inv.items) {
      const taxable = round2(num(item.total) - num(item.tax));
      const meta = (item.meta ?? {}) as { coveredAmount?: number };
      const discount = Math.max(0, round2(num(item.discount) - num(meta.coveredAmount)));
      lines.push({ code: REVENUE_ACCOUNT[item.itemType] ?? LEDGER.SERVICE_REVENUE, amount: -round2(taxable + discount) });
      if (discount > 0) lines.push({ code: LEDGER.DISCOUNTS, amount: discount });
    }
    lines.push({ code: LEDGER.TAX_PAYABLE, amount: -num(inv.tax) });
    lines.push({ code: LEDGER.ROUNDING, amount: -num(inv.rounding) });
    return this.post(client, { branchId: inv.branchId, referenceType: 'INVOICE', referenceId: inv.id, description: `Invoice ${inv.invoiceNumber}`, entryDate: inv.issuedAt ?? undefined, lines });
  }

  paymentReceived(client: DbOrTx, p: { id: string; branchId: string; amount: number; method: PaymentMethod | string; invoiceNumber: string; paidAt?: Date | null }) {
    return this.post(client, {
      branchId: p.branchId,
      referenceType: 'PAYMENT',
      referenceId: p.id,
      description: `${p.method} payment for ${p.invoiceNumber}`,
      entryDate: p.paidAt ?? undefined,
      lines: [
        { code: paymentAccount(p.method), amount: p.amount },
        { code: LEDGER.RECEIVABLES, amount: -p.amount },
      ],
    });
  }

  refundIssued(client: DbOrTx, r: { id: string; branchId: string; amount: number; method: PaymentMethod | string; invoiceNumber: string }) {
    return this.post(client, {
      branchId: r.branchId,
      referenceType: 'REFUND',
      referenceId: r.id,
      description: `Refund for ${r.invoiceNumber}`,
      lines: [
        { code: LEDGER.SALES_RETURNS, amount: r.amount },
        { code: paymentAccount(r.method), amount: -r.amount },
      ],
    });
  }

  /**
   * Posts the mirror image of what is still outstanding against a reference (used when voiding or
   * correcting). Earlier reversals are netted in, so reversing twice never double-counts.
   */
  async reverse(client: DbOrTx, referenceType: string, referenceId: string, description: string) {
    const entries = await client.ledgerEntry.findMany({
      where: { referenceType: { in: [referenceType, `${referenceType}_REVERSAL`] }, referenceId },
      include: { account: { select: { code: true } } },
    });
    if (!entries.length) return null;
    return this.post(client, {
      branchId: entries[0].branchId,
      referenceType: `${referenceType}_REVERSAL`,
      referenceId,
      description,
      lines: entries.map((e) => ({ code: e.account.code, amount: round2(num(e.credit) - num(e.debit)) })),
    });
  }

  recognisePackageRevenue(client: DbOrTx, r: { redemptionId: string; branchId: string; amount: number; entryDate?: Date }) {
    return this.post(client, {
      branchId: r.branchId,
      referenceType: 'PACKAGE_REDEMPTION',
      referenceId: r.redemptionId,
      description: 'Package session redeemed',
      entryDate: r.entryDate,
      lines: [
        { code: LEDGER.DEFERRED_REVENUE, amount: r.amount },
        { code: LEDGER.PACKAGE_REVENUE, amount: -r.amount },
      ],
    });
  }

  // ---------- reads ----------

  private range(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) };
  }

  async entries(q: { page: number; pageSize: number; branchId?: string; accountCode?: string; referenceType?: string; referenceId?: string; from?: string; to?: string }) {
    const where: Prisma.LedgerEntryWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.accountCode) where.account = { code: q.accountCode };
    if (q.referenceType) where.referenceType = q.referenceType;
    if (q.referenceId) where.referenceId = q.referenceId;
    const entryDate = this.range(q.from, q.to);
    if (entryDate) where.entryDate = entryDate;
    const [items, total] = await Promise.all([
      this.db.ledgerEntry.findMany({
        where,
        include: { account: { select: { code: true, name: true, type: true } } },
        orderBy: [{ entryDate: 'desc' }, { journalId: 'asc' }, { debit: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.ledgerEntry.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Account balances for a period; debits must equal credits. */
  async trialBalance(q: { branchId?: string; from?: string; to?: string }) {
    const tenantId = RequestContext.requireTenantId();
    await this.accountIds(this.db, tenantId);
    const where: Prisma.LedgerEntryWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    const entryDate = this.range(q.from, q.to);
    if (entryDate) where.entryDate = entryDate;
    const [accounts, sums] = await Promise.all([
      this.db.ledgerAccount.findMany({ orderBy: { code: 'asc' } }),
      this.db.ledgerEntry.groupBy({ by: ['accountId'], where, _sum: { debit: true, credit: true } }),
    ]);
    const byAccount = new Map(sums.map((s) => [s.accountId, s._sum]));
    const rows = accounts.map((a) => {
      const s = byAccount.get(a.id);
      const debit = num(s?.debit);
      const credit = num(s?.credit);
      const debitNormal = a.type === 'ASSET' || a.type === 'EXPENSE';
      return { code: a.code, name: a.name, type: a.type, debit, credit, balance: round2(debitNormal ? debit - credit : credit - debit) };
    });
    const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
    return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
  }
}
