import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { CartsService } from '../modules/billing/carts.service';
import { ServicesService } from '../modules/catalog/services.service';
import { ExpensesService } from '../modules/expenses/expenses.service';
import { InventoryService } from '../modules/inventory/inventory.service';
import { rng } from './demo-operations';
import type { DemoContext } from './demo';

const logger = new Logger('SeedDemo');

type ProductSeed = { name: string; sku: string; category: string; unit: string; cost: number; price: number; retail: boolean; consumable: boolean; buy: [number, number] };

const PRODUCTS: ProductSeed[] = [
  { name: 'Massage Base Oil', sku: 'CON-OIL-BASE', category: 'Oils', unit: 'ml', cost: 0.6, price: 0, retail: false, consumable: true, buy: [20000, 15000] },
  { name: 'Ayurvedic Herbal Oil', sku: 'CON-OIL-HERB', category: 'Oils', unit: 'ml', cost: 1.2, price: 0, retail: false, consumable: true, buy: [15000, 9000] },
  { name: 'Disposable Bed Sheet', sku: 'CON-SHEET', category: 'Consumables', unit: 'pcs', cost: 18, price: 0, retail: false, consumable: true, buy: [500, 400] },
  { name: 'Sheet Face Mask', sku: 'CON-MASK', category: 'Consumables', unit: 'pcs', cost: 45, price: 0, retail: false, consumable: true, buy: [60, 120] },
  { name: 'Herbal Potli', sku: 'CON-POTLI', category: 'Consumables', unit: 'pcs', cost: 120, price: 0, retail: false, consumable: true, buy: [40, 30] },
  { name: 'Foot Soak Salt', sku: 'CON-SALT', category: 'Consumables', unit: 'g', cost: 0.3, price: 0, retail: false, consumable: true, buy: [8000, 8000] },
  { name: 'Lavender Essential Oil 15ml', sku: 'RET-LAV-15', category: 'Aromatherapy', unit: 'pcs', cost: 280, price: 550, retail: true, consumable: false, buy: [30, 20] },
  { name: 'Eucalyptus Oil 30ml', sku: 'RET-EUC-30', category: 'Aromatherapy', unit: 'pcs', cost: 190, price: 399, retail: true, consumable: false, buy: [25, 20] },
  { name: 'Aroma Diffuser', sku: 'RET-DIFF', category: 'Aromatherapy', unit: 'pcs', cost: 900, price: 1799, retail: true, consumable: false, buy: [8, 6] },
  { name: 'Kumkumadi Face Oil 30ml', sku: 'RET-KUM-30', category: 'Skin Care', unit: 'pcs', cost: 450, price: 899, retail: true, consumable: false, buy: [15, 25] },
  { name: 'Relaxing Bath Salts 500g', sku: 'RET-BATH-500', category: 'Wellness Retail', unit: 'pcs', cost: 180, price: 399, retail: true, consumable: false, buy: [20, 20] },
  { name: 'Pain Relief Balm 50g', sku: 'RET-BALM-50', category: 'Wellness Retail', unit: 'pcs', cost: 120, price: 249, retail: true, consumable: false, buy: [40, 30] },
  { name: 'Herbal Hair Oil 200ml', sku: 'RET-HAIR-200', category: 'Wellness Retail', unit: 'pcs', cost: 150, price: 320, retail: true, consumable: false, buy: [25, 15] },
];

/** Consumables used by one session of each service. */
const CONSUMPTION: Record<string, Array<[string, number]>> = {
  'Swedish Massage': [['CON-OIL-BASE', 40], ['CON-SHEET', 1]],
  'Deep Tissue Massage': [['CON-OIL-BASE', 40], ['CON-SHEET', 1]],
  'Aromatherapy Massage': [['CON-OIL-BASE', 35], ['CON-SHEET', 1]],
  'Hot Stone Massage': [['CON-OIL-BASE', 50], ['CON-SHEET', 1]],
  'Head, Neck & Shoulder': [['CON-OIL-BASE', 15]],
  'Couple Massage': [['CON-OIL-BASE', 80], ['CON-SHEET', 2]],
  Abhyanga: [['CON-OIL-HERB', 60], ['CON-SHEET', 1]],
  Shirodhara: [['CON-OIL-HERB', 150], ['CON-SHEET', 1]],
  'Kizhi (Potli)': [['CON-POTLI', 1], ['CON-OIL-HERB', 30], ['CON-SHEET', 1]],
  'Foot Reflexology': [['CON-OIL-BASE', 15]],
  'Foot Spa': [['CON-SALT', 200]],
  Facial: [['CON-MASK', 1]],
};

/**
 * Stock history that matches the operations already seeded: opening purchases, per-service
 * consumables deducted for every past session, retail product sales through the POS, three months
 * of running expenses and a couple of inter-branch transfers. Some stock is left under its reorder
 * level so the low-stock screens and alerts have data.
 */
export async function seedInventory(ctx: DemoContext) {
  const { db, tenantId, app } = ctx;
  const r = rng(777);
  const inventory = app.get(InventoryService);
  const expenses = app.get(ExpensesService);
  const servicesService = app.get(ServicesService);
  const carts = app.get(CartsService);
  const tz = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone ?? 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);
  const [ind, kor] = ctx.branches;
  const branches = [ind, kor];

  const categories = new Map<string, string>();
  for (const name of [...new Set(PRODUCTS.map((p) => p.category))]) categories.set(name, (await inventory.createCategory(name)).id);
  const bySku = new Map<string, string>();
  for (const p of PRODUCTS) {
    const created = await inventory.createProduct({
      name: p.name,
      sku: p.sku,
      categoryId: categories.get(p.category),
      unit: p.unit,
      costPrice: p.cost,
      sellingPrice: p.price,
      taxRate: p.retail ? 18 : 0,
      isRetail: p.retail,
      isConsumable: p.consumable,
      status: 'ACTIVE',
    } as never);
    bySku.set(p.sku, created.id);
  }

  const services = await db.service.findMany({ where: { tenantId } });
  for (const s of services) {
    const use = CONSUMPTION[s.name];
    if (use) await servicesService.update(s.id, { consumables: use.map(([sku, quantity]) => ({ productId: bySku.get(sku)!, quantity })) });
  }

  // Opening stock 100 days ago, then top-ups; slow-moving lines are only bought once.
  const buy = async (branchIndex: number, daysAgo: number, share: number, supplier: string, only?: (p: ProductSeed) => boolean) => {
    const items = PRODUCTS.filter((p) => !only || only(p)).map((p) => ({ productId: bySku.get(p.sku)!, quantity: Math.round(p.buy[branchIndex] * share), unitCost: p.cost }));
    return inventory.purchase({
      branchId: branches[branchIndex].id,
      supplierName: supplier,
      referenceNumber: `PO-${branches[branchIndex].code}-${now.minus({ days: daysAgo }).toFormat('yyMMdd')}`,
      purchasedAt: now.minus({ days: daysAgo }).toISODate()!,
      paymentMethod: 'BANK_TRANSFER',
      recordExpense: true,
      items: items.filter((i) => i.quantity > 0),
    });
  };
  for (const b of [0, 1]) {
    await buy(b, 100, 1, 'Kerala Ayur Supplies');
    await buy(b, 55, 0.8, 'Kerala Ayur Supplies', (p) => p.consumable && p.sku !== 'CON-MASK');
    await buy(b, 20, 0.5, 'Wellness Distributors', (p) => p.retail || p.sku === 'CON-OIL-BASE' || p.sku === 'CON-SHEET');
  }

  // Past sessions consume stock exactly as the live session.completed handler would.
  const sessions = await db.therapySession.findMany({
    where: { tenantId, status: 'COMPLETED', completedAt: { not: null } },
    select: { id: true, serviceId: true, branchId: true, completedAt: true },
    orderBy: { completedAt: 'asc' },
  });
  for (const s of sessions) {
    await inventory.onSessionCompleted({ sessionId: s.id, serviceId: s.serviceId, branchId: s.branchId, completedAt: s.completedAt!.toISOString(), productsUsed: [] });
  }

  // Retail sales at the desk after a visit.
  const retail = PRODUCTS.filter((p) => p.retail);
  const customers = await db.customer.findMany({ where: { tenantId }, select: { id: true }, take: 200 });
  let sales = 0;
  for (let d = 85; d >= 1; d--) {
    for (const branch of branches) {
      if (!r.chance(0.45)) continue;
      const at = now.minus({ days: d }).set({ hour: 11 + Math.floor(r.next() * 8), minute: Math.floor(r.next() * 60) });
      const cart = await carts.create({ branchId: branch.id, customerId: customers[Math.floor(r.next() * customers.length)].id });
      const lines = r.chance(0.3) ? 2 : 1;
      for (let i = 0; i < lines; i++) {
        const p = retail[Math.floor(r.next() * retail.length)];
        await carts.addItem(cart.id, { itemType: 'PRODUCT', itemId: bySku.get(p.sku)!, quantity: r.chance(0.2) ? 2 : 1 });
      }
      const view = await carts.view(cart.id);
      try {
        await carts.checkout(cart.id, { payments: [{ method: r.chance(0.5) ? 'UPI' : r.chance(0.5) ? 'CARD' : 'CASH', amount: view.quote.total }] }, { at: at.toJSDate() });
        sales++;
      } catch {
        await db.cart.update({ where: { id: cart.id }, data: { status: 'ABANDONED' } }).catch(() => undefined);
      }
    }
  }

  // Inventory rows were written "now"; move them to when they actually happened.
  await db.$executeRaw`
    UPDATE inventory_transactions t SET "createdAt" = s."completedAt"
    FROM therapy_sessions s WHERE t."tenantId" = ${tenantId} AND t."referenceType" = 'SESSION' AND t."referenceId" = s.id`;
  await db.$executeRaw`
    UPDATE inventory_transactions t SET "createdAt" = p."purchasedAt" + interval '10 hours'
    FROM purchases p WHERE t."tenantId" = ${tenantId} AND t."referenceType" = 'PURCHASE' AND t."referenceId" = p.id`;
  await db.$executeRaw`
    UPDATE inventory_transactions t SET "createdAt" = i."issuedAt"
    FROM invoices i WHERE t."tenantId" = ${tenantId} AND t."referenceType" = 'INVOICE' AND t."referenceId" = i.id AND i."issuedAt" IS NOT NULL`;

  // Reorder levels at roughly two weeks of usage; a few lines are deliberately short.
  const stock = await db.inventoryStock.findMany({ where: { tenantId } });
  for (const s of stock) {
    const p = PRODUCTS.find((x) => bySku.get(x.sku) === s.productId)!;
    const opening = p.buy[s.branchId === ind.id ? 0 : 1];
    await inventory.setReorderLevel(s.branchId, s.productId, Math.max(1, Math.round(opening * 0.2)));
  }
  const short: Array<[string, string, number]> = [
    ['CON-MASK', kor.id, 10],
    ['CON-POTLI', ind.id, 4],
    ['RET-DIFF', ind.id, 1],
  ];
  for (const [sku, branchId, target] of short) {
    const s = await db.inventoryStock.findFirst({ where: { branchId, productId: bySku.get(sku)! } });
    const current = Number(s?.quantity ?? 0);
    if (current > target) await inventory.adjust({ branchId, productId: bySku.get(sku)!, type: 'DAMAGE', quantity: current - target, notes: 'Damaged in storage (demo)' });
  }

  // One completed and one pending transfer.
  const done = await inventory.requestTransfer({ fromBranchId: ind.id, toBranchId: kor.id, notes: 'Weekend demand at Koramangala', items: [{ productId: bySku.get('RET-LAV-15')!, quantity: 4 }, { productId: bySku.get('CON-OIL-HERB')!, quantity: 1000 }] });
  await inventory.approveTransfer(done.id);
  await inventory.receiveTransfer(done.id);
  await inventory.requestTransfer({ fromBranchId: kor.id, toBranchId: ind.id, notes: 'Running low on face masks', items: [{ productId: bySku.get('CON-MASK')!, quantity: 5 }] });

  // Running costs for the last three months.
  let expenseCount = 0;
  const cost = async (branchId: string, category: string, amount: number, date: DateTime, description: string, vendor: string, paymentMethod: 'CASH' | 'UPI' | 'BANK_TRANSFER' = 'BANK_TRANSFER') => {
    if (date > now) return;
    await expenses.create({ branchId, category, amount, expenseDate: date.toISODate()!, description, vendor, paymentMethod } as never);
    expenseCount++;
  };
  for (let m = 2; m >= 0; m--) {
    const month = now.minus({ months: m }).startOf('month');
    const label = month.toFormat('LLLL yyyy');
    for (const [i, b] of branches.entries()) {
      const scale = i === 0 ? 1 : 0.85;
      await cost(b.id, 'RENT', i === 0 ? 85000 : 110000, month.plus({ days: 1 }), `Rent for ${label}`, 'Prestige Estates');
      await cost(b.id, 'ELECTRICITY', Math.round((12000 + r.next() * 4000) * scale), month.plus({ days: 6 }), `BESCOM bill ${label}`, 'BESCOM', 'UPI');
      await cost(b.id, 'INTERNET', 1499, month.plus({ days: 4 }), `Broadband ${label}`, 'ACT Fibernet', 'UPI');
      await cost(b.id, 'SUPPLIES', Math.round(3000 + r.next() * 2500), month.plus({ days: 12 }), 'Towels, laundry and cleaning supplies', 'CleanPro Services', 'CASH');
      if (r.chance(0.6)) await cost(b.id, 'MAINTENANCE', Math.round(2000 + r.next() * 6000), month.plus({ days: 17 }), 'AC servicing and plumbing', 'CoolAir Services', 'CASH');
      await cost(b.id, 'MARKETING', Math.round((8000 + r.next() * 7000) * scale), month.plus({ days: 9 }), 'Instagram and Google ads', 'Meta / Google Ads', 'UPI');
      await cost(b.id, 'SALARY', Math.round(165000 * scale), month.endOf('month').startOf('day'), `Staff salaries ${label}`, 'Payroll');
    }
  }

  logger.log(`Inventory: ${PRODUCTS.length} products, ${sessions.length} sessions consumed stock, ${sales} retail sales, ${expenseCount} expenses, 2 transfers`);
}
