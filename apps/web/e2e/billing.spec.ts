import { expect, login, test } from './fixtures';

const PAGES: { path: string; heading: string | RegExp }[] = [
  { path: '/pos', heading: 'Point of Sale' },
  { path: '/invoices', heading: 'Invoices' },
  { path: '/payments', heading: 'Payments' },
  { path: '/packages', heading: 'Packages' },
  { path: '/memberships', heading: 'Memberships' },
  { path: '/offers', heading: 'Offers & coupons' },
];

test.describe('billing screens (owner)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'owner@serenity.demo');
  });

  for (const p of PAGES) {
    test(`${p.path} renders without errors`, async ({ page, errors }) => {
      await page.goto(p.path);
      await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
    });
  }

  test('invoice detail opens from the list', async ({ page, errors }) => {
    await page.goto('/invoices');
    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();
    const number = (await firstRow.locator('td').first().locator('p').first().textContent())?.trim();
    await firstRow.click();
    await expect(page).toHaveURL(/\/invoices\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(number!);
    await expect(page.getByText('Balance due')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('package and membership tabs switch', async ({ page, errors }) => {
    await page.goto('/packages');
    await expect(page.getByText('Swedish Relax x5')).toBeVisible();
    await page.getByRole('button', { name: 'Customer packages' }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.goto('/memberships');
    await expect(page.getByText('Gold Wellness')).toBeVisible();
    await page.getByRole('button', { name: 'Members' }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.goto('/offers');
    await page.getByRole('button', { name: 'Coupons' }).click();
    await expect(page.getByText('WELCOME10')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('POS: sell a service at the counter and take cash', async ({ page, errors }) => {
    await page.goto('/pos');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByPlaceholder('Search the catalogue').fill('Swedish');
    await page.getByRole('button', { name: /Swedish/ }).first().click();
    await expect(page.getByText('Total', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await expect(page.getByRole('heading', { name: /Invoice INV-/ })).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});
