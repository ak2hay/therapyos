import { Injectable, Logger } from '@nestjs/common';
import { InventoryTxnType, Prisma, TransferStatus } from '@prisma/client';
import { FeatureFlagKey } from '@therapyos/types';
import { ProductInput, PurchaseInput, StockAdjustInput, TransferInput } from '@therapyos/validation';
import { RequestContext } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { Db, DbOrTx, InjectDb } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/utils/dates';
import { num, round2 } from '../../common/utils/money';
import { paged } from '../../common/utils/pagination';
import { AuditService } from '../../core/audit.service';
import { DomainEvents, EventsService } from '../../core/events.service';
import { FeaturesService } from '../../core/features.service';
import { OnDomainEvent } from '../../jobs/event-handlers';
import { LEDGER } from '../ledger/ledger.accounts';
import { LedgerService, paymentAccount } from '../ledger/ledger.service';

export interface StockMove {
  branchId: string;
  productId: string;
  /** Positive adds stock, negative removes it. */
  delta: number;
  type: InventoryTxnType;
  unitCost?: number | null;
  referenceType?: string;
  referenceId?: string;
  notes?: string | null;
  /** Consumption during a session must never block the session, so it may drive stock negative. */
  allowNegative?: boolean;
}

const round3 = (v: number) => Math.round((v + Number.EPSILON) * 1000) / 1000;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly features: FeaturesService,
  ) {}

  // ---------- product catalogue ----------

  listCategories() {
    return this.db.productCategory.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
  }

  async createCategory(name: string) {
    const tenantId = RequestContext.requireTenantId();
    const exists = await this.db.productCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (exists) throw AppError.conflict(`A category called "${name}" already exists.`);
    return this.db.productCategory.create({ data: { tenantId, name } });
  }

  async listProducts(q: { search?: string; categoryId?: string; branchId?: string; consumable?: boolean; retail?: boolean; all?: boolean }) {
    const where: Prisma.ProductWhereInput = {};
    if (!q.all) where.status = 'ACTIVE';
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.consumable) where.isConsumable = true;
    if (q.retail) where.isRetail = true;
    if (q.search) where.OR = [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }, { barcode: q.search }];
    const branchIds = RequestContext.branchScope(q.branchId);
    const rows = await this.db.product.findMany({
      where,
      include: { category: { select: { id: true, name: true } }, stock: { where: branchIds ? { branchId: { in: branchIds } } : {}, select: { branchId: true, quantity: true, reorderLevel: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map(({ stock, ...p }) => {
      const onHand = round3(stock.reduce((s, x) => s + num(x.quantity), 0));
      return {
        ...p,
        onHand,
        stockValue: round2(onHand * num(p.costPrice)),
        lowStock: stock.some((x) => num(x.reorderLevel) > 0 && num(x.quantity) <= num(x.reorderLevel)),
        stock: stock.map((x) => ({ branchId: x.branchId, quantity: num(x.quantity), reorderLevel: num(x.reorderLevel) })),
      };
    });
  }

  async getProduct(id: string) {
    const p = await this.db.product.findFirst({ where: { id }, include: { category: true, stock: { include: { branch: { select: { id: true, name: true } } } } } });
    if (!p) throw AppError.notFound('Product');
    return p;
  }

  private async assertSkuFree(sku: string, exceptId?: string) {
    const clash = await this.db.product.findFirst({ where: { sku: { equals: sku, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw AppError.conflict(`SKU ${sku} is already used by ${clash.name}.`, ErrorCode.DUPLICATE);
  }

  async createProduct(input: ProductInput) {
    const tenantId = RequestContext.requireTenantId();
    await this.assertSkuFree(input.sku);
    const p = await this.db.product.create({ data: { ...input, tenantId } });
    await this.audit.log({ action: 'PRODUCT_CREATED', entityType: 'Product', entityId: p.id, newValues: input });
    return this.getProduct(p.id);
  }

  async updateProduct(id: string, input: Partial<ProductInput>) {
    const before = await this.getProduct(id);
    if (input.sku && input.sku !== before.sku) await this.assertSkuFree(input.sku, id);
    await this.db.product.update({ where: { id }, data: input });
    const priceChanged = input.sellingPrice !== undefined && num(before.sellingPrice) !== input.sellingPrice;
    await this.audit.log({ action: priceChanged ? 'PRICE_CHANGED' : 'PRODUCT_UPDATED', entityType: 'Product', entityId: id, oldValues: { sellingPrice: before.sellingPrice, costPrice: before.costPrice, status: before.status }, newValues: input });
    return this.getProduct(id);
  }

  // ---------- stock ----------

  async stock(q: { page: number; pageSize: number; branchId?: string; categoryId?: string; lowStock?: boolean; search?: string }) {
    const product: Prisma.ProductWhereInput = { status: 'ACTIVE' };
    if (q.categoryId) product.categoryId = q.categoryId;
    if (q.search) product.OR = [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }];
    const where: Prisma.InventoryStockWhereInput = { ...RequestContext.branchFilter(q.branchId), product };
    if (q.lowStock) {
      // Prisma cannot compare two columns, so the low-stock filter is resolved with a narrow raw query first.
      const tenantId = RequestContext.requireTenantId();
      const ids = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_stock WHERE "tenantId" = ${tenantId} AND "reorderLevel" > 0 AND quantity <= "reorderLevel"`;
      where.id = { in: ids.map((r) => r.id) };
    }
    const [items, total, value] = await Promise.all([
      this.db.inventoryStock.findMany({
        where,
        include: { product: { select: { id: true, name: true, sku: true, unit: true, costPrice: true, sellingPrice: true, isRetail: true, isConsumable: true, category: { select: { name: true } } } }, branch: { select: { id: true, name: true } } },
        orderBy: [{ product: { name: 'asc' } }, { branch: { name: 'asc' } }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.inventoryStock.count({ where }),
      this.db.inventoryStock.findMany({ where, select: { quantity: true, product: { select: { costPrice: true } } } }),
    ]);
    const result = paged(
      items.map((s) => ({ ...s, lowStock: num(s.reorderLevel) > 0 && num(s.quantity) <= num(s.reorderLevel), stockValue: round2(num(s.quantity) * num(s.product.costPrice)) })),
      total,
      q,
    );
    Object.assign(result.meta, { summary: { stockValue: round2(value.reduce((s, v) => s + Math.max(0, num(v.quantity)) * num(v.product.costPrice), 0)) } });
    return result;
  }

  async transactions(q: { page: number; pageSize: number; branchId?: string; productId?: string; type?: string; from?: string; to?: string }) {
    const where: Prisma.InventoryTransactionWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.productId) where.productId = q.productId;
    if (q.type) where.type = { in: q.type.split(',') as InventoryTxnType[] };
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}) };
    const [items, total] = await Promise.all([
      this.db.inventoryTransaction.findMany({ where, include: { product: { select: { id: true, name: true, sku: true, unit: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.inventoryTransaction.count({ where }),
    ]);
    const branches = await this.db.branch.findMany({ where: { id: { in: [...new Set(items.map((i) => i.branchId))] } }, select: { id: true, name: true } });
    const names = new Map(branches.map((b) => [b.id, b.name]));
    return paged(items.map((t) => ({ ...t, branchName: names.get(t.branchId) ?? null })), total, q);
  }

  /**
   * The single entry point for changing stock. The quantity is updated with one atomic UPDATE so
   * concurrent sales cannot oversell, and every change leaves an InventoryTransaction behind.
   */
  async move(tx: DbOrTx, m: StockMove) {
    const tenantId = RequestContext.requireTenantId();
    const delta = round3(m.delta);
    if (delta === 0) return null;
    await tx.inventoryStock.upsert({
      where: { branchId_productId: { branchId: m.branchId, productId: m.productId } },
      create: { tenantId, branchId: m.branchId, productId: m.productId, quantity: 0 },
      update: {},
    });
    const guard = m.allowNegative || delta > 0 ? Prisma.empty : Prisma.sql`AND quantity + ${delta} >= 0`;
    const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal; reorderLevel: Prisma.Decimal; lowStockAlertAt: Date | null }[]>`
      UPDATE inventory_stock SET quantity = quantity + ${delta}, "updatedAt" = now()
      WHERE "branchId" = ${m.branchId} AND "productId" = ${m.productId} ${guard}
      RETURNING quantity, "reorderLevel", "lowStockAlertAt"`;
    if (!rows.length) {
      const [p, s] = await Promise.all([
        tx.product.findFirst({ where: { id: m.productId }, select: { name: true, unit: true } }),
        tx.inventoryStock.findFirst({ where: { branchId: m.branchId, productId: m.productId }, select: { quantity: true } }),
      ]);
      throw AppError.badRequest(ErrorCode.INSUFFICIENT_STOCK, `Only ${num(s?.quantity)} ${p?.unit ?? ''} of ${p?.name ?? 'this product'} left in stock.`.replace(/\s+/g, ' '), {
        productId: m.productId,
        available: num(s?.quantity),
        requested: -delta,
      });
    }
    await tx.inventoryTransaction.create({
      data: {
        tenantId,
        branchId: m.branchId,
        productId: m.productId,
        type: m.type,
        quantity: delta,
        unitCost: m.unitCost ?? null,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        notes: m.notes ?? null,
        createdBy: RequestContext.userId ?? null,
      },
    });
    const after = num(rows[0].quantity);
    const reorder = num(rows[0].reorderLevel);
    if (reorder > 0 && after <= reorder && !rows[0].lowStockAlertAt) {
      await tx.inventoryStock.update({ where: { branchId_productId: { branchId: m.branchId, productId: m.productId } }, data: { lowStockAlertAt: new Date() } });
      await this.events.publish(DomainEvents.STOCK_LOW, { branchId: m.branchId, productId: m.productId, quantity: after, reorderLevel: reorder }, tx);
    } else if (rows[0].lowStockAlertAt && after > reorder) {
      await tx.inventoryStock.update({ where: { branchId_productId: { branchId: m.branchId, productId: m.productId } }, data: { lowStockAlertAt: null } });
    }
    return after;
  }

  async adjust(input: StockAdjustInput) {
    RequestContext.assertBranch(input.branchId);
    const product = await this.getProduct(input.productId);
    // Damage and consumption always remove stock; adjustments and returns use the sign given.
    const delta = input.type === 'DAMAGE' || input.type === 'CONSUMPTION' ? -Math.abs(input.quantity) : input.quantity;
    await this.db.$transaction(async (tx) => {
      await this.move(tx, { branchId: input.branchId, productId: input.productId, delta, type: input.type, unitCost: num(product.costPrice), referenceType: 'MANUAL', notes: input.notes });
      const value = round2(Math.abs(delta) * num(product.costPrice));
      if (value > 0) {
        await this.ledger.post(tx, {
          branchId: input.branchId,
          referenceType: 'STOCK_ADJUSTMENT',
          referenceId: `${input.productId}:${Date.now()}`,
          description: `${input.type.toLowerCase()} ${Math.abs(delta)} ${product.unit} ${product.name}`,
          lines: delta < 0 ? [{ code: LEDGER.COGS, amount: value }, { code: LEDGER.INVENTORY, amount: -value }] : [{ code: LEDGER.INVENTORY, amount: value }, { code: LEDGER.COGS, amount: -value }],
        });
      }
    });
    await this.audit.log({ action: 'STOCK_ADJUSTED', entityType: 'Product', entityId: input.productId, newValues: { ...input, delta } });
    return this.getProduct(input.productId);
  }

  async setReorderLevel(branchId: string, productId: string, reorderLevel: number) {
    RequestContext.assertBranch(branchId);
    const tenantId = RequestContext.requireTenantId();
    await this.getProduct(productId);
    const s = await this.db.inventoryStock.upsert({
      where: { branchId_productId: { branchId, productId } },
      create: { tenantId, branchId, productId, quantity: 0, reorderLevel },
      update: { reorderLevel },
    });
    if (num(s.quantity) > reorderLevel && s.lowStockAlertAt) await this.db.inventoryStock.update({ where: { id: s.id }, data: { lowStockAlertAt: null } });
    return { branchId, productId, reorderLevel, quantity: num(s.quantity) };
  }

  // ---------- purchases ----------

  async listPurchases(q: { page: number; pageSize: number; branchId?: string; from?: string; to?: string }) {
    const where: Prisma.PurchaseWhereInput = { ...RequestContext.branchFilter(q.branchId) };
    if (q.from || q.to) where.purchasedAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}) };
    const [items, total] = await Promise.all([
      this.db.purchase.findMany({ where, include: { items: true }, orderBy: { purchasedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.purchase.count({ where }),
    ]);
    const productIds = [...new Set(items.flatMap((p) => p.items.map((i) => i.productId)))];
    const [products, branches] = await Promise.all([
      this.db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, unit: true } }),
      this.db.branch.findMany({ where: { id: { in: [...new Set(items.map((p) => p.branchId))] } }, select: { id: true, name: true } }),
    ]);
    const pn = new Map(products.map((p) => [p.id, p]));
    const bn = new Map(branches.map((b) => [b.id, b.name]));
    return paged(
      items.map((p) => ({ ...p, branchName: bn.get(p.branchId) ?? null, items: p.items.map((i) => ({ ...i, productName: pn.get(i.productId)?.name ?? null, unit: pn.get(i.productId)?.unit ?? null })) })),
      total,
      q,
    );
  }

  /**
   * Receiving stock: quantities go up, product cost moves to the weighted average, and the books
   * show Inventory (asset) against the cash or bank account used. The optional expense row is for
   * the expense register only; it is not posted again, so the P&L sees the cost once, via COGS.
   */
  async purchase(input: PurchaseInput) {
    RequestContext.assertBranch(input.branchId);
    const tenantId = RequestContext.requireTenantId();
    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const products = await this.db.product.findMany({ where: { id: { in: productIds } } });
    if (products.length !== productIds.length) throw AppError.notFound('Product');
    const purchasedAt = input.purchasedAt ? dateOnly(input.purchasedAt) : new Date();
    const totalCost = round2(input.items.reduce((s, i) => s + i.quantity * i.unitCost, 0));

    const purchase = await this.db.$transaction(async (tx) => {
      const p = await tx.purchase.create({
        data: {
          tenantId,
          branchId: input.branchId,
          supplierName: input.supplierName,
          referenceNumber: input.referenceNumber,
          totalCost,
          purchasedAt,
          createdBy: RequestContext.userId ?? null,
          items: { create: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitCost: i.unitCost })) },
        },
      });
      for (const productId of productIds) {
        const lines = input.items.filter((i) => i.productId === productId);
        const qty = lines.reduce((s, i) => s + i.quantity, 0);
        const cost = lines.reduce((s, i) => s + i.quantity * i.unitCost, 0);
        const onHand = await tx.inventoryStock.aggregate({ where: { productId }, _sum: { quantity: true } });
        const existingQty = Math.max(0, num(onHand._sum.quantity));
        const product = products.find((x) => x.id === productId)!;
        const avg = existingQty + qty > 0 ? round2((existingQty * num(product.costPrice) + cost) / (existingQty + qty)) : round2(cost / qty);
        await tx.product.update({ where: { id: productId }, data: { costPrice: avg } });
        for (const line of lines) {
          await this.move(tx, { branchId: input.branchId, productId, delta: line.quantity, type: 'PURCHASE', unitCost: line.unitCost, referenceType: 'PURCHASE', referenceId: p.id, notes: input.supplierName });
        }
      }
      if (input.recordExpense) {
        const e = await tx.expense.create({
          data: {
            tenantId,
            branchId: input.branchId,
            category: 'INVENTORY',
            amount: totalCost,
            description: `Stock purchase${input.referenceNumber ? ` ${input.referenceNumber}` : ''}`,
            expenseDate: dateOnly((input.purchasedAt ?? new Date().toISOString()).slice(0, 10)),
            paymentMethod: input.paymentMethod,
            vendor: input.supplierName,
            createdBy: RequestContext.userId ?? null,
          },
        });
        await tx.purchase.update({ where: { id: p.id }, data: { expenseId: e.id } });
      }
      await this.ledger.post(tx, {
        branchId: input.branchId,
        referenceType: 'PURCHASE',
        referenceId: p.id,
        description: `Stock purchase from ${input.supplierName}`,
        entryDate: purchasedAt,
        lines: [
          { code: LEDGER.INVENTORY, amount: totalCost },
          { code: paymentAccount(input.paymentMethod), amount: -totalCost },
        ],
      });
      return p;
    });
    await this.audit.log({ action: 'STOCK_PURCHASED', entityType: 'Purchase', entityId: purchase.id, newValues: { supplierName: input.supplierName, totalCost, items: input.items.length } });
    return purchase;
  }

  // ---------- transfers ----------

  private transferInclude = { items: true } satisfies Prisma.InventoryTransferInclude;

  async listTransfers(q: { page: number; pageSize: number; status?: string; branchId?: string }) {
    const where: Prisma.InventoryTransferWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as TransferStatus[] };
    const scope = RequestContext.branchScope(q.branchId);
    if (scope) where.OR = [{ fromBranchId: { in: scope } }, { toBranchId: { in: scope } }];
    const [items, total] = await Promise.all([
      this.db.inventoryTransfer.findMany({ where, include: this.transferInclude, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.inventoryTransfer.count({ where }),
    ]);
    return paged(await this.presentTransfers(items), total, q);
  }

  private async presentTransfers<T extends { fromBranchId: string; toBranchId: string; items: { productId: string }[] }>(rows: T[]) {
    const [branches, products] = await Promise.all([
      this.db.branch.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.fromBranchId, r.toBranchId]))] } }, select: { id: true, name: true } }),
      this.db.product.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.items.map((i) => i.productId)))] } }, select: { id: true, name: true, unit: true } }),
    ]);
    const bn = new Map(branches.map((b) => [b.id, b.name]));
    const pn = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => ({
      ...r,
      fromBranchName: bn.get(r.fromBranchId) ?? null,
      toBranchName: bn.get(r.toBranchId) ?? null,
      items: r.items.map((i) => ({ ...i, productName: pn.get(i.productId)?.name ?? null, unit: pn.get(i.productId)?.unit ?? null })),
    }));
  }

  private async loadTransfer(id: string) {
    const t = await this.db.inventoryTransfer.findFirst({ where: { id }, include: this.transferInclude });
    if (!t) throw AppError.notFound('Transfer');
    return t;
  }

  async getTransfer(id: string) {
    return (await this.presentTransfers([await this.loadTransfer(id)]))[0];
  }

  async requestTransfer(input: TransferInput) {
    const tenantId = RequestContext.requireTenantId();
    RequestContext.assertBranch(input.toBranchId);
    const t = await this.db.inventoryTransfer.create({
      data: {
        tenantId,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        notes: input.notes,
        requestedBy: RequestContext.userId ?? null,
        items: { create: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
      },
    });
    await this.audit.log({ action: 'TRANSFER_REQUESTED', entityType: 'InventoryTransfer', entityId: t.id, newValues: input });
    return this.getTransfer(t.id);
  }

  /** Approval dispatches the goods: stock leaves the source branch immediately. */
  async approveTransfer(id: string) {
    const t = await this.loadTransfer(id);
    if (t.status !== 'REQUESTED') throw AppError.invalidState(`Transfer is ${t.status.toLowerCase()}.`);
    await this.db.$transaction(async (tx) => {
      const res = await tx.inventoryTransfer.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'APPROVED', approvedBy: RequestContext.userId ?? null, approvedAt: new Date() } });
      if (!res.count) throw AppError.invalidState('Transfer was already processed.');
      for (const i of t.items) {
        await this.move(tx, { branchId: t.fromBranchId, productId: i.productId, delta: -num(i.quantity), type: 'TRANSFER_OUT', referenceType: 'TRANSFER', referenceId: id });
      }
    });
    await this.audit.log({ action: 'TRANSFER_APPROVED', entityType: 'InventoryTransfer', entityId: id });
    return this.getTransfer(id);
  }

  async receiveTransfer(id: string) {
    const t = await this.loadTransfer(id);
    RequestContext.assertBranch(t.toBranchId);
    if (t.status !== 'APPROVED') throw AppError.invalidState('Only approved (dispatched) transfers can be received.');
    await this.db.$transaction(async (tx) => {
      const res = await tx.inventoryTransfer.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'COMPLETED', completedAt: new Date() } });
      if (!res.count) throw AppError.invalidState('Transfer was already processed.');
      for (const i of t.items) {
        await this.move(tx, { branchId: t.toBranchId, productId: i.productId, delta: num(i.quantity), type: 'TRANSFER_IN', referenceType: 'TRANSFER', referenceId: id });
      }
    });
    await this.audit.log({ action: 'TRANSFER_RECEIVED', entityType: 'InventoryTransfer', entityId: id });
    return this.getTransfer(id);
  }

  /** Rejecting a request, or cancelling a dispatched transfer (which puts the stock back at the source). */
  async closeTransfer(id: string, action: 'REJECTED' | 'CANCELLED') {
    const t = await this.loadTransfer(id);
    if (!['REQUESTED', 'APPROVED'].includes(t.status)) throw AppError.invalidState(`Transfer is ${t.status.toLowerCase()}.`);
    await this.db.$transaction(async (tx) => {
      const res = await tx.inventoryTransfer.updateMany({ where: { id, status: t.status }, data: { status: action } });
      if (!res.count) throw AppError.invalidState('Transfer was already processed.');
      if (t.status === 'APPROVED') {
        for (const i of t.items) {
          await this.move(tx, { branchId: t.fromBranchId, productId: i.productId, delta: num(i.quantity), type: 'TRANSFER_IN', referenceType: 'TRANSFER', referenceId: id, notes: 'Transfer cancelled, stock returned' });
        }
      }
    });
    await this.audit.log({ action: `TRANSFER_${action}`, entityType: 'InventoryTransfer', entityId: id });
    return this.getTransfer(id);
  }

  // ---------- billing & session hooks ----------

  private async tracking(tenantId: string) {
    return this.features.isEnabled(tenantId, FeatureFlagKey.INVENTORY_ENABLED);
  }

  /** Called inside checkout: retail products leave stock and their cost moves to COGS. */
  async sellForInvoice(tx: DbOrTx, invoice: { id: string; branchId: string; invoiceNumber: string; issuedAt?: Date | null }, items: { itemId: string; quantity: number }[]) {
    if (!items.length || !(await this.tracking(RequestContext.requireTenantId()))) return;
    const products = await tx.product.findMany({ where: { id: { in: items.map((i) => i.itemId) } }, select: { id: true, costPrice: true } });
    const cost = new Map(products.map((p) => [p.id, num(p.costPrice)]));
    let cogs = 0;
    for (const i of items) {
      await this.move(tx, { branchId: invoice.branchId, productId: i.itemId, delta: -i.quantity, type: 'SALE', unitCost: cost.get(i.itemId) ?? 0, referenceType: 'INVOICE', referenceId: invoice.id });
      cogs += i.quantity * (cost.get(i.itemId) ?? 0);
    }
    cogs = round2(cogs);
    if (cogs > 0) {
      await this.ledger.post(tx, {
        branchId: invoice.branchId,
        referenceType: 'INVENTORY_SALE',
        referenceId: invoice.id,
        description: `Cost of goods for ${invoice.invoiceNumber}`,
        entryDate: invoice.issuedAt ?? undefined,
        lines: [{ code: LEDGER.COGS, amount: cogs }, { code: LEDGER.INVENTORY, amount: -cogs }],
      });
    }
  }

  /** Called when an invoice is voided: sold goods go back on the shelf. */
  async returnForInvoice(tx: DbOrTx, invoice: { id: string; invoiceNumber: string }) {
    const sold = await tx.inventoryTransaction.findMany({ where: { referenceType: 'INVOICE', referenceId: invoice.id, type: 'SALE' } });
    const returned = await tx.inventoryTransaction.count({ where: { referenceType: 'INVOICE_VOID', referenceId: invoice.id } });
    if (!sold.length || returned) return;
    for (const s of sold) {
      await this.move(tx, { branchId: s.branchId, productId: s.productId, delta: -num(s.quantity), type: 'RETURN', unitCost: s.unitCost ? num(s.unitCost) : null, referenceType: 'INVOICE_VOID', referenceId: invoice.id, notes: `${invoice.invoiceNumber} voided` });
    }
    await this.ledger.reverse(tx, 'INVENTORY_SALE', invoice.id, `${invoice.invoiceNumber} voided, goods returned`);
  }

  /**
   * Session consumables (configured per service) plus anything the therapist recorded as used are
   * deducted from the branch. Runs once per session and never blocks: stock may go negative, which
   * surfaces as a low-stock alert rather than a failed session.
   */
  @OnDomainEvent('session.completed')
  async onSessionCompleted(payload: Record<string, any>) {
    const tenantId = RequestContext.requireTenantId();
    if (!(await this.tracking(tenantId))) return;
    const done = await this.db.inventoryTransaction.count({ where: { referenceType: 'SESSION', referenceId: payload.sessionId } });
    if (done) return;
    const consumables = await this.db.serviceConsumable.findMany({ where: { serviceId: payload.serviceId } });
    const usage = new Map<string, number>();
    for (const c of consumables) usage.set(c.productId, (usage.get(c.productId) ?? 0) + num(c.quantity));
    for (const u of (payload.productsUsed ?? []) as { productId: string; quantity: number }[]) usage.set(u.productId, (usage.get(u.productId) ?? 0) + Number(u.quantity));
    if (!usage.size) return;
    const products = await this.db.product.findMany({ where: { id: { in: [...usage.keys()] } }, select: { id: true, costPrice: true } });
    const cost = new Map(products.map((p) => [p.id, num(p.costPrice)]));
    await this.db.$transaction(async (tx) => {
      let value = 0;
      for (const [productId, qty] of usage) {
        if (!cost.has(productId)) continue;
        await this.move(tx, { branchId: payload.branchId, productId, delta: -qty, type: 'CONSUMPTION', unitCost: cost.get(productId), referenceType: 'SESSION', referenceId: payload.sessionId, allowNegative: true });
        value += qty * cost.get(productId)!;
      }
      value = round2(value);
      if (value > 0) {
        await this.ledger.post(tx, {
          branchId: payload.branchId,
          referenceType: 'SESSION_CONSUMPTION',
          referenceId: payload.sessionId,
          description: 'Products consumed in session',
          entryDate: payload.completedAt ? new Date(payload.completedAt) : undefined,
          lines: [{ code: LEDGER.COGS, amount: value }, { code: LEDGER.INVENTORY, amount: -value }],
        });
      }
    });
  }

  /** Products at or under their reorder level, for dashboards and the daily digest. */
  async lowStock(branchId?: string) {
    const tenantId = RequestContext.requireTenantId();
    const scope = RequestContext.branchScope(branchId);
    const rows = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_stock WHERE "tenantId" = ${tenantId} AND "reorderLevel" > 0 AND quantity <= "reorderLevel"`;
    return this.db.inventoryStock.findMany({
      where: { id: { in: rows.map((r) => r.id) }, ...(scope ? { branchId: { in: scope } } : {}), product: { status: 'ACTIVE' } },
      include: { product: { select: { id: true, name: true, unit: true, sku: true } }, branch: { select: { id: true, name: true } } },
      orderBy: { quantity: 'asc' },
    });
  }
}
