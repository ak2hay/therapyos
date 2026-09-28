import '../bootstrap-env';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { DB, Db } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { AuthzService } from '../core/authz.service';
import { hashPassword, ProvisioningService } from '../modules/tenants/provisioning.service';
import { RbacService } from '../modules/rbac/rbac.service';
import { PLANS, SYSTEM_TEMPLATES } from './seed-data';
import { seedDemoTenant } from './demo';
import { seedPlatformTenants } from './demo-scale';

const logger = new Logger('Seed');

async function seedPlatform(db: Db) {
  for (const plan of PLANS) {
    await db.subscriptionPlan.upsert({ where: { code: plan.code }, create: plan, update: plan });
  }
  for (const t of SYSTEM_TEMPLATES) {
    const existing = await db.notificationTemplate.findFirst({
      where: { tenantId: null, event: t.event, channel: t.channel, language: 'en' },
    });
    if (!existing) await db.notificationTemplate.create({ data: { ...t, tenantId: null, language: 'en' } });
  }
  const email = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@rkyves.com';
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? 'Admin@12345';
  await db.platformAdmin.upsert({
    where: { email },
    create: { email, name: 'Rkyves Super Admin', passwordHash: await hashPassword(password) },
    update: {},
  });
  logger.log(`Platform seeded (plans, templates, super admin ${email})`);
}

export async function runSeed(app: INestApplicationContext) {
  const db = app.get<Db>(DB);
  await app.get(RbacService).syncPermissions();
  await seedPlatform(db);

  let tenantId: string;
  let ownerId: string;
  const existing = await db.tenant.findUnique({ where: { slug: 'serenity-wellness' } });
  if (existing) {
    tenantId = existing.id;
    ownerId = (await db.user.findFirstOrThrow({ where: { tenantId, email: 'owner@serenity.demo' } })).id;
  } else {
    const { tenant, owner } = await app.get(ProvisioningService).provision({
      businessName: 'Serenity Wellness',
      ownerName: 'Ananya Sharma',
      email: 'owner@serenity.demo',
      phone: '+919800000001',
      password: 'Demo@12345',
    });
    tenantId = tenant.id;
    ownerId = owner.id;
    await db.tenant.update({ where: { id: tenantId }, data: { slug: 'serenity-wellness' } });
    const enterprise = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: 'ENTERPRISE' } });
    await db.tenantSubscription.updateMany({
      where: { tenantId },
      data: { planId: enterprise.id, status: 'ACTIVE', trialEndDate: null, renewalDate: new Date(Date.now() + 30 * 86_400_000) },
    });
    await db.tenant.update({ where: { id: tenantId }, data: { subscriptionPlanId: enterprise.id, status: 'ACTIVE' } });
  }
  if (!existing?.onboardingCompletedAt) {
    await db.tenant.update({
      where: { id: tenantId },
      data: {
        businessType: 'WELLNESS',
        legalName: 'Serenity Wellness Pvt Ltd',
        taxId: '29ABCDE1234F1Z5',
        address: '100 Feet Road, Indiranagar, Bengaluru 560038',
        onboardingStep: 10,
        onboardingCompletedAt: new Date(),
      },
    });
  }
  await db.tenant.updateMany({ where: { id: tenantId, status: 'ONBOARDING' }, data: { status: 'ACTIVE' } });

  const authz = await app.get(AuthzService).getUserAuthz(ownerId);
  await RequestContext.runAsTenant(
    tenantId,
    () => seedDemoTenant(app, tenantId, ownerId),
    { userId: ownerId, permissions: new Set(authz!.permissions), allBranches: true },
  );
  await app.get(AuthzService).invalidateTenant(tenantId);
  await seedPlatformTenants(app);
  logger.log('Demo tenant "serenity-wellness" ready. Login: owner@serenity.demo / Demo@12345');
}

async function main() {
  process.env.DISABLE_WORKERS = 'true';
  process.env.NOTIFICATIONS_SUPPRESS = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    await runSeed(app);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
