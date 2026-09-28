import { INestApplicationContext, Logger } from '@nestjs/common';
import { DB, Db } from '../common/prisma/prisma.service';
import { BranchesService } from '../modules/branches/branches.service';
import { UsersService } from '../modules/users/users.service';
import { ServicesService } from '../modules/catalog/services.service';
import { TherapistsService } from '../modules/catalog/therapists.service';
import { OutboxRelay } from '../jobs/outbox.relay';
import { seedOperations } from './demo-operations';
import { seedBilling } from './demo-billing';
import { seedInventory } from './demo-inventory';
import { seedGrowth } from './demo-growth';
import { seedScale } from './demo-scale';

const logger = new Logger('SeedDemo');

export interface DemoContext {
  app: INestApplicationContext;
  db: Db;
  tenantId: string;
  ownerId: string;
  branches: { id: string; code: string }[];
  roles: Record<string, string>;
}

async function seedFoundation(ctx: DemoContext) {
  const branchesService = ctx.app.get(BranchesService);
  const main = await branchesService.create({
    name: 'Serenity Indiranagar',
    code: 'IND',
    phone: '+918040000001',
    address: '100 Feet Road, Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
    openingTime: '09:00',
    closingTime: '21:00',
    status: 'ACTIVE',
    publicBookingEnabled: true,
  });
  const second = await branchesService.create({
    name: 'Serenity Koramangala',
    code: 'KOR',
    phone: '+918040000002',
    address: '80 Feet Road, Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    openingTime: '10:00',
    closingTime: '22:00',
    status: 'ACTIVE',
    publicBookingEnabled: true,
  });
  ctx.branches = [main, second];

  const roles = await ctx.db.role.findMany({ where: { tenantId: ctx.tenantId } });
  ctx.roles = Object.fromEntries(roles.map((r) => [r.key ?? r.name, r.id]));

  const users = ctx.app.get(UsersService);
  const staff: Array<{ name: string; email: string; phone: string; role: string; branch?: string; therapist?: boolean }> = [
    { name: 'Rohit Menon', email: 'hq@serenity.demo', phone: '+919800000002', role: 'HQ_ADMIN' },
    { name: 'Kavya Iyer', email: 'manager@serenity.demo', phone: '+919800000003', role: 'BRANCH_MANAGER', branch: main.id },
    { name: 'Priya Nair', email: 'reception@serenity.demo', phone: '+919800000004', role: 'RECEPTIONIST', branch: main.id },
    { name: 'Meera Pillai', email: 'reception2@serenity.demo', phone: '+919800000005', role: 'RECEPTIONIST', branch: second.id },
    { name: 'Suresh Kumar', email: 'accounts@serenity.demo', phone: '+919800000006', role: 'ACCOUNTANT' },
    { name: 'Farhan Ali', email: 'inventory@serenity.demo', phone: '+919800000007', role: 'INVENTORY_MANAGER' },
    { name: 'Arjun Das', email: 'arjun@serenity.demo', phone: '+919800000011', role: 'THERAPIST', branch: main.id, therapist: true },
    { name: 'Lakshmi Rao', email: 'lakshmi@serenity.demo', phone: '+919800000012', role: 'THERAPIST', branch: main.id, therapist: true },
    { name: 'Vikram Singh', email: 'vikram@serenity.demo', phone: '+919800000013', role: 'THERAPIST', branch: main.id, therapist: true },
    { name: 'Deepa Joshi', email: 'deepa@serenity.demo', phone: '+919800000014', role: 'THERAPIST', branch: second.id, therapist: true },
    { name: 'Rahul Verma', email: 'rahul.t@serenity.demo', phone: '+919800000015', role: 'THERAPIST', branch: second.id, therapist: true },
  ];
  for (const s of staff) {
    await users.create({
      name: s.name,
      email: s.email,
      phone: s.phone,
      password: 'Demo@12345',
      sendInvite: false,
      isTherapist: !!s.therapist,
      roles: [{ roleId: ctx.roles[s.role], branchId: s.branch ?? null }],
    });
  }
  logger.log(`Foundation: ${ctx.branches.length} branches, ${staff.length} staff`);
}

async function seedCatalog(ctx: DemoContext) {
  const { db, tenantId } = ctx;
  await db.taxRate.create({ data: { tenantId, name: 'GST 18%', rate: 18, type: 'GST', isDefault: true } });
  await db.taxRate.create({ data: { tenantId, name: 'GST 5%', rate: 5, type: 'GST' } });

  const services = ctx.app.get(ServicesService);
  const catalog: Record<string, Array<[string, number, number, string?]>> = {
    Massage: [
      ['Swedish Massage', 60, 1800],
      ['Deep Tissue Massage', 60, 2200],
      ['Aromatherapy Massage', 60, 2000],
      ['Hot Stone Massage', 75, 2800],
      ['Head, Neck & Shoulder', 30, 900],
    ],
    Ayurveda: [
      ['Abhyanga', 60, 2000, 'Full body warm oil massage'],
      ['Shirodhara', 45, 2500, 'Continuous oil flow on the forehead'],
      ['Kizhi (Potli)', 60, 2400],
    ],
    'Foot Care': [
      ['Foot Reflexology', 45, 1000],
      ['Foot Spa', 45, 900],
    ],
    Wellness: [
      ['Facial', 60, 1800],
      ['Couple Massage', 60, 3800],
    ],
  };
  const created: Record<string, string> = {};
  let sort = 0;
  for (const [category, list] of Object.entries(catalog)) {
    const cat = await services.createCategory({ name: category, sortOrder: sort++, status: 'ACTIVE' });
    for (const [name, durationMinutes, basePrice, description] of list) {
      const s = await services.create({ name, description, categoryId: cat.id, durationMinutes, basePrice, taxRate: 18, status: 'ACTIVE' });
      created[name] = s.id;
    }
  }
  const [ind, kor] = ctx.branches;
  // Koramangala is a premium location: higher prices on signature massages, no hot stone.
  await services.setBranchOverride(created['Swedish Massage'], { branchId: kor.id, price: 2000, isActive: true });
  await services.setBranchOverride(created['Deep Tissue Massage'], { branchId: kor.id, price: 2500, isActive: true });
  await services.setBranchOverride(created['Hot Stone Massage'], { branchId: kor.id, isActive: false });

  const therapistsService = ctx.app.get(TherapistsService);
  const therapists = await db.therapist.findMany({ orderBy: { employeeCode: 'asc' } });
  const skills: Record<string, { services: string[]; specialization: string; commission: ['PERCENTAGE' | 'FIXED_PER_SESSION' | 'TIERED', number] }> = {
    'Arjun Das': { services: ['Swedish Massage', 'Deep Tissue Massage', 'Hot Stone Massage', 'Head, Neck & Shoulder', 'Couple Massage'], specialization: 'Deep tissue & sports massage', commission: ['PERCENTAGE', 15] },
    'Lakshmi Rao': { services: ['Abhyanga', 'Shirodhara', 'Kizhi (Potli)', 'Aromatherapy Massage'], specialization: 'Ayurvedic therapies', commission: ['PERCENTAGE', 18] },
    'Vikram Singh': { services: ['Foot Reflexology', 'Foot Spa', 'Swedish Massage', 'Head, Neck & Shoulder', 'Couple Massage'], specialization: 'Reflexology', commission: ['FIXED_PER_SESSION', 250] },
    'Deepa Joshi': { services: ['Facial', 'Aromatherapy Massage', 'Swedish Massage', 'Foot Spa'], specialization: 'Skin & aromatherapy', commission: ['TIERED', 10] },
    'Rahul Verma': { services: ['Deep Tissue Massage', 'Abhyanga', 'Foot Reflexology', 'Head, Neck & Shoulder'], specialization: 'Therapeutic massage', commission: ['PERCENTAGE', 12] },
  };
  for (const t of therapists) {
    const cfg = skills[t.name];
    if (!cfg) continue;
    const branch = t.primaryBranchId === kor.id ? kor : ind;
    const branchRow = await db.branch.findUniqueOrThrow({ where: { id: branch.id } });
    await therapistsService.update(t.id, {
      specialization: cfg.specialization,
      serviceIds: cfg.services.map((n) => created[n]),
      commissionType: cfg.commission[0],
      commissionValue: cfg.commission[1],
      commissionTiers: cfg.commission[0] === 'TIERED' ? [{ minSessions: 0, value: 10 }, { minSessions: 40, value: 15 }, { minSessions: 80, value: 20 }] : undefined,
      joiningDate: '2025-04-01',
    });
    const days = t.name === 'Vikram Singh' ? [0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
    await therapistsService.setSchedule(t.id, {
      schedules: days.map((dayOfWeek) => ({ branchId: branch.id, dayOfWeek, startTime: branchRow.openingTime, endTime: branchRow.closingTime })),
    });
  }
  // Rahul also covers Indiranagar on Sunday mornings.
  const rahul = therapists.find((t) => t.name === 'Rahul Verma');
  if (rahul) {
    const current = await db.therapistSchedule.findMany({ where: { therapistId: rahul.id } });
    await therapistsService.setSchedule(rahul.id, {
      schedules: [...current.map((s) => ({ branchId: s.branchId, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })), { branchId: ind.id, dayOfWeek: 0, startTime: '09:00', endTime: '14:00' }],
    });
  }
  logger.log(`Catalog: ${Object.keys(created).length} services, ${therapists.length} therapists configured`);
}

/** An area manager responsible for the franchised Koramangala branch only (HQ dashboard scoping). */
async function seedAreaManager(ctx: DemoContext) {
  const kor = ctx.branches.find((b) => b.code === 'KOR');
  if (!kor || !ctx.roles.AREA_MANAGER) return;
  await ctx.app.get(UsersService).create({
    name: 'Nikhil Rao',
    email: 'area@serenity.demo',
    phone: '+919800000008',
    password: 'Demo@12345',
    sendInvite: false,
    isTherapist: false,
    roles: [{ roleId: ctx.roles.AREA_MANAGER, branchId: kor.id }],
  });
  logger.log('Area manager: area@serenity.demo (Koramangala)');
}

/** Map coordinates so the customer app can sort centres by distance. */
async function seedBranchLocations(ctx: DemoContext) {
  const coords: Record<string, [number, number, string]> = {
    IND: [12.9719, 77.6412, '100 Feet Road, HAL 2nd Stage, Indiranagar'],
    KOR: [12.9352, 77.6245, '80 Feet Road, 4th Block, Koramangala'],
  };
  for (const b of ctx.branches) {
    const c = coords[b.code];
    if (!c) continue;
    await ctx.db.branch.updateMany({ where: { id: b.id, latitude: null }, data: { latitude: c[0], longitude: c[1] } });
    await ctx.db.branch.updateMany({ where: { id: b.id, address: null }, data: { address: c[2] } });
  }
  logger.log('Branch locations set');
}

export interface DemoStep {
  key: string;
  run: (ctx: DemoContext) => Promise<void>;
}

export const DEMO_STEPS: DemoStep[] = [
  { key: 'foundation', run: seedFoundation },
  { key: 'catalog', run: seedCatalog },
  { key: 'operations', run: seedOperations },
  { key: 'billing', run: seedBilling },
  { key: 'inventory', run: seedInventory },
  { key: 'growth', run: seedGrowth },
  { key: 'scale', run: seedScale },
  { key: 'area-manager', run: seedAreaManager },
  { key: 'branch-locations', run: seedBranchLocations },
];

const STEPS_SETTING = 'DEMO_SEED_STEPS';

/** Runs every demo step not yet applied to this tenant, so the demo dataset can grow without a database reset. */
export async function seedDemoTenant(app: INestApplicationContext, tenantId: string, ownerId: string) {
  const db = app.get<Db>(DB);
  const ctx: DemoContext = { app, db, tenantId, ownerId, branches: [], roles: {} };
  const setting = await db.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key: STEPS_SETTING } } });
  const done = new Set<string>((setting?.value as string[] | undefined) ?? []);
  if (!setting && (await db.branch.count({ where: { tenantId } })) > 0) done.add('foundation');

  const loadContext = async () => {
    ctx.branches = await db.branch.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, code: true } });
    const roles = await db.role.findMany({ where: { tenantId } });
    ctx.roles = Object.fromEntries(roles.map((r) => [r.key ?? r.name, r.id]));
  };
  await loadContext();

  for (const step of DEMO_STEPS) {
    if (done.has(step.key)) continue;
    logger.log(`Running demo step: ${step.key}`);
    await step.run(ctx);
    await app.get(OutboxRelay).processInline();
    done.add(step.key);
    await db.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: STEPS_SETTING } },
      create: { tenantId, key: STEPS_SETTING, value: [...done] },
      update: { value: [...done] },
    });
    await loadContext();
  }
}
