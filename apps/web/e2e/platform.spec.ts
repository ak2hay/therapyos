import { type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_PASSWORD, DEMO_TENANT, expect, login, test, watchErrors } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@rkyves.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Admin@12345';

async function apiToken(request: APIRequestContext, path: string, body: Record<string, string>) {
  const res = await request.post(`/api/v1/auth/${path}`, { data: body });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data.tokens.accessToken as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function adminLogin(page: Page) {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
}

test.describe('platform: HQ, franchise, SaaS console and public booking', () => {
  test('owner: HQ dashboard, franchise, subscription, branding and API keys', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');

    await page.goto('/hq');
    await expect(page.getByRole('heading', { level: 1, name: 'HQ Overview' })).toBeVisible();
    await expect(page.getByTestId('hq-table').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('hq-trend')).toBeVisible();
    await page.getByTestId('hq-table').getByText('Sessions', { exact: true }).click();

    await page.goto('/franchise');
    await expect(page.getByTestId('franchisee-card').filter({ hasText: 'Koramangala Wellness LLP' })).toBeVisible();
    await page.getByRole('button', { name: 'Fees & royalties' }).click();
    await expect(page.getByTestId('fee-row').first()).toBeVisible();

    await page.goto('/settings?tab=subscription');
    await expect(page.getByTestId('current-plan')).toContainText('Enterprise plan');
    await expect(page.getByTestId('plan-card')).toHaveCount(4);
    await expect(page.getByText('Billing history')).toBeVisible();

    await page.getByRole('button', { name: 'Branding', exact: true }).click();
    await page.getByPlaceholder('Serenity Wellness').fill('Serenity Preview');
    await expect(page.getByTestId('branding-preview')).toContainText('Serenity Preview');

    await page.getByRole('button', { name: 'API keys', exact: true }).click();
    await page.getByRole('button', { name: 'New key' }).click();
    const name = `E2E key ${Date.now()}`;
    await page.getByRole('dialog').getByRole('textbox').first().fill(name);
    await page.getByRole('dialog').getByLabel('Read services').check();
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect(page.getByTestId('new-api-key')).toHaveValue(/^tos_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: `Revoke ${name}` }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: name }).getByText('Revoked')).toBeVisible();

    await page.goto('/branches');
    await page.getByTitle('Branch QR').first().click();
    await expect(page.getByTestId('booking-qr')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('guest books online from the branch booking page', async ({ page, errors }) => {
    await page.goto(`/book/${DEMO_TENANT}?branch=ind`);
    await expect(page.getByText('Book an appointment online')).toBeVisible();
    await page.getByTestId('booking-service').filter({ hasText: 'Swedish Massage' }).click();
    const tomorrow = new Date(Date.now() + 86_400_000);
    await page.getByLabel('Booking date').fill(tomorrow.toISOString().slice(0, 10));
    await page.getByTestId('booking-slots').getByRole('button').last().click();
    await page.getByLabel('Full name').fill('E2E Online Guest');
    await page.getByLabel('Mobile number').fill(`+9196${String(Date.now()).slice(-8)}`);
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(page.getByTestId('booking-confirmed')).toContainText('Swedish Massage');
    expect(errors).toEqual([]);
  });

  test('support ticket round trip between a business and the platform team', async ({ browser, page, errors }) => {
    const subject = `E2E help ${Date.now()}`;
    await login(page, 'owner@serenity.demo');
    await page.goto('/support');
    await page.getByRole('button', { name: 'New ticket' }).click();
    await page.getByPlaceholder('Short summary of the issue').fill(subject);
    await page.getByRole('dialog').locator('textarea').fill('Reports export shows the wrong month.');
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByTestId('ticket-conversation')).toBeVisible();

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    const adminErrors = watchErrors(admin);
    await adminLogin(admin);
    await admin.goto('/admin/support');
    await admin.getByTestId('admin-ticket-item').filter({ hasText: subject }).click();
    await expect(admin.getByText('Serenity Wellness').first()).toBeVisible();
    await admin.getByPlaceholder(/Reply to the business/).fill('Fixed in today’s release, please retry.');
    await admin.getByRole('button', { name: 'Send reply' }).click();
    await expect(admin.getByTestId('ticket-conversation')).toContainText('Fixed in today’s release');
    expect(adminErrors).toEqual([]);
    await adminContext.close();

    await page.reload();
    await expect(page.getByTestId('ticket-conversation')).toContainText('Fixed in today’s release');
    await expect(page.getByText('Awaiting your reply').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('super admin console: metrics, tenants, overrides, plans, flags and health', async ({ page, errors }) => {
    await adminLogin(page);
    await expect(page.getByTestId('platform-metrics')).toContainText('MRR');
    await expect(page.getByTestId('platform-trend')).toBeVisible();

    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByTestId('tenant-row').first()).toBeVisible();
    await page.getByLabel('Search businesses').fill('mindful');
    await expect(page.getByTestId('tenant-row')).toHaveCount(1);
    await page.getByRole('link', { name: 'Mindful Care Clinic' }).click();
    await expect(page.getByTestId('tenant-subscription')).toContainText('Starter');
    const override = page.getByLabel('Override FRANCHISE');
    await override.selectOption('on');
    await expect(page.getByTestId('flag-FRANCHISE')).toContainText('On');
    await override.selectOption('');
    await expect(page.getByTestId('flag-FRANCHISE')).toContainText('Off');

    await page.goto('/admin/plans');
    await expect(page.getByTestId('admin-plan')).toHaveCount(4);
    await page.goto('/admin/flags');
    await expect(page.getByTestId('global-flag-WHITE_LABEL')).toContainText('ENTERPRISE');
    await page.goto('/admin/system');
    await expect(page.getByTestId('service-database')).toContainText('Up');
    await expect(page.getByTestId('service-redis')).toContainText('Up');
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('custom domain serves the white-label booking page', async ({ browser, request }) => {
    const token = await apiToken(request, 'login', { identifier: 'owner@serenity.demo', password: DEMO_PASSWORD });
    const before = (await (await request.get('/api/v1/branding', { headers: auth(token) })).json()).data ?? {};
    const domain = `book-${Date.now()}.serenity-e2e.test`;
    const put = await request.put('/api/v1/branding', { headers: auth(token), data: { ...before, customDomain: domain, appName: 'Serenity Spa Club', poweredBy: false } });
    expect(put.ok(), await put.text()).toBeTruthy();
    try {
      const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-host': domain } });
      const guest = await ctx.newPage();
      await guest.goto('/');
      await expect(guest.getByRole('heading', { name: 'Serenity Spa Club' })).toBeVisible();
      await expect(guest.getByText('Powered by TherapyOS')).toHaveCount(0);
      await ctx.close();
    } finally {
      await request.put('/api/v1/branding', { headers: auth(token), data: { ...before, customDomain: undefined } });
    }
  });

  test('a suspended business sees the paused screen until reactivated', async ({ page, request }) => {
    const adminToken = await apiToken(request, 'admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const list = await (await request.get('/api/v1/admin/tenants?search=fitfix', { headers: auth(adminToken) })).json();
    const tenantId = list.data[0].id as string;
    await request.patch(`/api/v1/admin/tenants/${tenantId}/status`, { headers: auth(adminToken), data: { status: 'SUSPENDED', reason: 'E2E: payment overdue' } });
    try {
      await login(page, 'owner@fitfix.demo');
      await expect(page.getByTestId('suspended-screen')).toContainText('E2E: payment overdue');
      await expect(page.getByTestId('current-plan')).toBeVisible();
    } finally {
      await request.patch(`/api/v1/admin/tenants/${tenantId}/status`, { headers: auth(adminToken), data: { status: 'ACTIVE' } });
    }
    await page.reload();
    await expect(page.getByTestId('suspended-screen')).toHaveCount(0);
  });
});
