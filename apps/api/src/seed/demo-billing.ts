import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { CartsService } from '../modules/billing/carts.service';
import { InvoicesService } from '../modules/billing/invoices.service';
import { PaymentsService } from '../modules/billing/payments.service';
import { MembershipsService } from '../modules/memberships/memberships.service';
import { OffersService } from '../modules/offers/offers.service';
import { PackagesService } from '../modules/packages/packages.service';
import { rng } from './demo-operations';
import type { DemoContext } from './demo';

const logger = new Logger('SeedDemo');

/**
 * Billing history through the real POS flow: every completed session is invoiced and paid on
 * the day it happened, some loyal customers buy packages or memberships and use them, and a
 * few recent bills are left unpaid, refunded or voided so every screen has something to show.
 */
export async function seedBilling(ctx: DemoContext) {
  const { db, tenantId, app } = ctx;
  const r = rng(4242);
  const carts = app.get(CartsService);
  const invoices = app.get(InvoicesService);
  const payments = app.get(PaymentsService);
  const packages = app.get(PackagesService);
  const memberships = app.get(MembershipsService);
  const offers = app.get(OffersService);
  const tz = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone ?? 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);

  const services = await db.service.findMany({ where: { tenantId } });
  const sid = (name: string) => services.find((s) => s.name === name)!.id;

  const pkgSwedish = await packages.create({ name: 'Swedish Relax x5', description: 'Five Swedish massages at 15% off', validityDays: 90, price: 7650, taxRate: 18, status: 'ACTIVE', items: [{ serviceId: sid('Swedish Massage'), quantity: 5 }] });
  const pkgAyurveda = await packages.create({
    name: 'Ayurveda Rejuvenation',
    description: '3 Abhyanga + 2 Shirodhara over four months',
    validityDays: 120,
    price: 9900,
    taxRate: 18,
    status: 'ACTIVE',
    items: [
      { serviceId: sid('Abhyanga'), quantity: 3 },
      { serviceId: sid('Shirodhara'), quantity: 2 },
    ],
  });
  const pkgFoot = await packages.create({
    name: 'Happy Feet Combo',
    description: '4 reflexology + 2 foot spa sessions',
    validityDays: 60,
    price: 4800,
    taxRate: 18,
    status: 'ACTIVE',
    items: [
      { serviceId: sid('Foot Reflexology'), quantity: 4 },
      { serviceId: sid('Foot Spa'), quantity: 2 },
    ],
  });
  const silver = await memberships.createPlan({
    name: 'Silver Club',
    description: '10% off every therapy plus priority booking',
    price: 1499,
    taxRate: 18,
    billingInterval: 'MONTHLY',
    durationDays: 30,
    status: 'ACTIVE',
    benefits: [
      { type: 'SERVICE_DISCOUNT_PERCENT', value: 10 },
      { type: 'PRIORITY_BOOKING', value: 0 },
    ],
  });
  const gold = await memberships.createPlan({
    name: 'Gold Wellness',
    description: '15% off therapies, 10% off retail and 3 free head & shoulder sessions a quarter',
    price: 5999,
    taxRate: 18,
    billingInterval: 'QUARTERLY',
    durationDays: 90,
    status: 'ACTIVE',
    benefits: [
      { type: 'SERVICE_DISCOUNT_PERCENT', value: 15 },
      { type: 'PRODUCT_DISCOUNT_PERCENT', value: 10 },
      { type: 'INCLUDED_SESSIONS', serviceId: sid('Head, Neck & Shoulder'), value: 0, quantity: 3 },
      { type: 'PRIORITY_BOOKING', value: 0 },
    ],
  });
  const packageFor = (serviceId: string) => [pkgSwedish, pkgAyurveda, pkgFoot].find((p) => p.items.some((i) => i.serviceId === serviceId));

  const sessions = await db.therapySession.findMany({
    where: { tenantId, status: 'COMPLETED', invoiceId: null, completedAt: { lt: now.startOf('day').toJSDate() } },
    orderBy: { completedAt: 'asc' },
    select: { id: true, customerId: true, serviceId: true, branchId: true, completedAt: true },
  });
  const visitsBy = new Map<string, number>();
  for (const s of sessions) visitsBy.set(s.customerId, (visitsBy.get(s.customerId) ?? 0) + 1);
  const frequent = [...visitsBy.entries()].filter(([, n]) => n >= 6).map(([c]) => c);
  const packageBuyers = new Set(frequent.filter((_, i) => i % 3 === 0).slice(0, 6));
  const goldBuyers = new Set(frequent.filter((_, i) => i % 3 === 1).slice(0, 3));
  const silverBuyers = new Set(frequent.filter((_, i) => i % 3 === 2).slice(0, 3));
  const owned = new Map<string, string>();
  const joined = new Set<string>();

  const method = () => {
    const x = r.next();
    return x < 0.35 ? 'CASH' : x < 0.8 ? 'UPI' : 'CARD';
  };
  let issued = 0;
  let packagesSold = 0;
  let plansSold = 0;
  let covered = 0;
  const recentInvoices: string[] = [];

  for (const s of sessions) {
    const at = s.completedAt!;
    const daysAgo = now.diff(DateTime.fromJSDate(at), 'days').days;
    const cart = await carts.create({ branchId: s.branchId, customerId: s.customerId });
    const ownedPackage = owned.get(s.customerId);
    const eligible = ownedPackage ? (await packages.eligible(s.customerId, s.serviceId)).find((p) => p.id === ownedPackage) : undefined;
    if (!ownedPackage && packageBuyers.has(s.customerId) && daysAgo < 55 && packageFor(s.serviceId)) {
      await carts.addItem(cart.id, { itemType: 'PACKAGE', itemId: packageFor(s.serviceId)!.id, quantity: 1 });
      packagesSold++;
    }
    if (!joined.has(s.customerId) && ((goldBuyers.has(s.customerId) && daysAgo < 70) || (silverBuyers.has(s.customerId) && daysAgo < 25))) {
      await carts.addItem(cart.id, { itemType: 'MEMBERSHIP', itemId: goldBuyers.has(s.customerId) ? gold.id : silver.id, quantity: 1 });
      joined.add(s.customerId);
      plansSold++;
    }
    await carts.addItem(cart.id, { itemType: 'SERVICE', itemId: s.serviceId, quantity: 1, sessionId: s.id, customerPackageId: eligible?.id });
    if (eligible) {
      await db.therapySession.update({ where: { id: s.id }, data: { customerPackageId: eligible.id } });
      covered++;
    }
    const view = await carts.view(cart.id);
    const total = view.quote.total;
    const leaveUnpaid = daysAgo < 3 && r.chance(0.25);
    const partial = !leaveUnpaid && daysAgo < 6 && r.chance(0.15);
    const pay = leaveUnpaid ? [] : partial ? [{ method: method(), amount: Math.round(total / 2) }] : total > 0 ? [{ method: method(), amount: total }] : [];
    const invoice = await carts.checkout(cart.id, { payments: pay }, { at });
    // Packages bought in this visit can be used from the next one.
    const bought = await db.customerPackage.findFirst({ where: { purchaseInvoiceId: invoice.id, status: 'ACTIVE' } });
    if (bought) owned.set(s.customerId, bought.id);
    if (daysAgo < 10) recentInvoices.push(invoice.id);
    issued++;
  }

  // A refund and a voided bill for the accounting screens.
  const paidRecent = await db.invoice.findMany({ where: { id: { in: recentInvoices }, status: 'PAID' }, include: { payments: true, items: true }, orderBy: { createdAt: 'desc' } });
  const toRefund = paidRecent.find((i) => i.items.every((it) => it.itemType === 'SERVICE' && !it.customerPackageId) && i.payments.length === 1);
  if (toRefund) await payments.refund({ paymentId: toRefund.payments[0].id, amount: Math.round(Number(toRefund.total) * 0.3), reason: 'Session cut short due to power outage' });
  const unpaid = await db.invoice.findFirst({ where: { id: { in: recentInvoices }, status: 'ISSUED' }, include: { items: true } });
  if (unpaid && unpaid.items.every((i) => i.itemType === 'SERVICE')) await invoices.void(unpaid.id, 'Duplicate bill created at the desk');

  // Current promotions (created after the history so old bills are not affected).
  const today = now.toISODate()!;
  const monthEnd = now.endOf('month').plus({ days: 10 }).toISODate()!;
  const ayurveda = await db.serviceCategory.findFirst({ where: { tenantId, name: 'Ayurveda' } });
  await offers.createOffer({ name: 'Ayurveda Week', description: '10% off all Ayurveda therapies', offerType: 'PERCENTAGE', value: 10, appliesTo: 'CATEGORY', targetIds: ayurveda ? [ayurveda.id] : [], branchIds: [], startDate: today, endDate: monthEnd, autoApply: true, status: 'ACTIVE' });
  await offers.createOffer({ name: 'Big Spender', description: 'Rs 300 off bills above Rs 5000', offerType: 'FIXED', value: 300, appliesTo: 'ALL', targetIds: [], branchIds: [], minOrder: 5000, startDate: today, endDate: monthEnd, autoApply: true, status: 'ACTIVE' });
  await offers.createOffer({ name: 'Foot Spa BOGO', description: 'Buy one foot spa, get one free (Koramangala)', offerType: 'BUY_ONE_GET_ONE', value: 0, appliesTo: 'SERVICE', targetIds: [sid('Foot Spa')], branchIds: [ctx.branches[1]?.id].filter(Boolean) as string[], startDate: today, endDate: monthEnd, autoApply: true, status: 'ACTIVE' });
  await offers.createOffer({ name: 'Monsoon Special', description: 'Last season: 20% off massages', offerType: 'PERCENTAGE', value: 20, appliesTo: 'ALL', targetIds: [], branchIds: [], startDate: now.minus({ months: 3 }).toISODate()!, endDate: now.minus({ months: 2 }).toISODate()!, autoApply: true, status: 'ACTIVE' });
  await offers.createCoupon({ code: 'WELCOME10', description: '10% off the first visit, up to Rs 300', discountType: 'PERCENTAGE', discountValue: 10, maximumDiscount: 300, perCustomerLimit: 1, startDate: now.minus({ months: 6 }).toISODate()!, endDate: now.plus({ months: 6 }).toISODate()!, status: 'ACTIVE' });
  await offers.createCoupon({ code: 'FLAT250', description: 'Rs 250 off orders above Rs 2000', discountType: 'FIXED', discountValue: 250, minimumOrder: 2000, usageLimit: 200, startDate: today, endDate: now.plus({ months: 2 }).toISODate()!, status: 'ACTIVE' });
  await offers.createCoupon({ code: 'SUMMER15', description: 'Expired summer campaign', discountType: 'PERCENTAGE', discountValue: 15, startDate: now.minus({ months: 5 }).toISODate()!, endDate: now.minus({ months: 3 }).toISODate()!, status: 'ACTIVE' });

  logger.log(`Billing: ${issued} invoices, ${packagesSold} packages, ${plansSold} memberships, ${covered} package-covered visits${toRefund ? ', 1 refund' : ''}${unpaid ? ', 1 void' : ''}`);
}
