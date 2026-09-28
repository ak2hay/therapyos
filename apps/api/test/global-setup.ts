import './setup-env';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RequestContext } from '../src/common/context/request-context';
import { DB, Db } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token.service';
import { runSeed } from '../src/seed/seed';
import { FIXTURES_FILE, Fixtures } from './fixtures';

const PASSWORD = 'Demo@12345';
const STAFF = {
  owner: 'owner@serenity.demo',
  hq: 'hq@serenity.demo',
  manager: 'manager@serenity.demo',
  reception: 'reception@serenity.demo',
  therapist: 'arjun@serenity.demo',
  area: 'area@serenity.demo',
  accountant: 'accounts@serenity.demo',
  otherOwner: 'owner@mindfulcare.demo',
} as const;

/**
 * Prepares the `_test` database once per run: applies pending migrations (never resets), seeds the demo
 * businesses if missing and issues tokens for each role through the services, so test files don't burn the
 * login rate limit.
 */
export default async function globalSetup() {
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), stdio: 'ignore', env: process.env });

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get<Db>(DB);
    if (!(await db.tenant.findUnique({ where: { slug: 'mindful-care' } }))) await runSeed(app);

    const auth = app.get(AuthService);
    const tokens = app.get(TokenService);
    const login = (identifier: string) => RequestContext.runAsTenant(undefined, () => auth.login({ identifier, password: PASSWORD })).then((r) => r.tokens);

    const serenity = await db.tenant.findUniqueOrThrow({ where: { slug: 'serenity-wellness' } });
    const mindful = await db.tenant.findUniqueOrThrow({ where: { slug: 'mindful-care' } });
    const ind = await db.branch.findFirstOrThrow({ where: { tenantId: serenity.id, code: 'IND' } });
    const kor = await db.branch.findFirstOrThrow({ where: { tenantId: serenity.id, code: 'KOR' } });
    const aarav = await db.customer.findFirstOrThrow({ where: { tenantId: serenity.id, phone: '+919845010036' } });
    const otherCustomer = await db.customer.findFirstOrThrow({ where: { tenantId: serenity.id, id: { not: aarav.id }, status: 'ACTIVE' } });
    const invoice = await db.invoice.findFirstOrThrow({ where: { tenantId: serenity.id, status: { not: 'DRAFT' }, customerId: { not: aarav.id } } });
    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId: serenity.id, customerId: { not: aarav.id } } });
    const service = await db.service.findFirstOrThrow({ where: { tenantId: serenity.id, status: 'ACTIVE' } });

    const staffTokens = Object.fromEntries(await Promise.all(Object.entries(STAFF).map(async ([k, email]) => [k, await login(email)]))) as Fixtures['tokens'];
    const adminEmail = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@rkyves.com';
    const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? 'Admin@12345';
    const admin = await RequestContext.runAsTenant(undefined, () => auth.adminLogin(adminEmail, adminPassword));

    const fixtures: Fixtures = {
      tenants: { serenity: serenity.id, other: mindful.id },
      branches: { ind: ind.id, kor: kor.id },
      customers: { aarav: aarav.id, other: otherCustomer.id },
      invoiceId: invoice.id,
      appointmentId: appointment.id,
      serviceId: service.id,
      tokens: {
        ...staffTokens,
        admin: admin.tokens,
        customer: await tokens.issueForCustomer(aarav),
        otherCustomer: await tokens.issueForCustomer(otherCustomer),
      },
    };
    writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures));
  } finally {
    await app.close();
  }
}
