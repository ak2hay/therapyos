import { expect, login, test } from './fixtures';

const PAGES: { path: string; heading: string | RegExp }[] = [
  { path: '/dashboard', heading: /Good (morning|afternoon|evening)/ },
  { path: '/inventory', heading: 'Inventory' },
  { path: '/expenses', heading: 'Expenses' },
  { path: '/reports', heading: 'Reports' },
];

test.describe('management screens (owner)', () => {
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

  test('owner dashboard shows KPIs, trend and alerts', async ({ page, errors }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('Billed today')).toBeVisible();
    await expect(page.getByText('Billing, last 30 days')).toBeVisible();
    await expect(page.getByText(/products low on stock/)).toBeVisible();
    await page.getByRole('button', { name: 'Front desk' }).click();
    await expect(page.getByText('Completed but not billed')).toBeVisible();
    await page.getByRole('button', { name: 'Accounts' }).click();
    await expect(page.getByText('Receivables ageing')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('inventory tabs load their data', async ({ page, errors }) => {
    await page.goto('/inventory');
    await expect(page.getByText('Stock value (at cost)')).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    for (const tab of ['Products', 'Purchases', 'Transfers', 'Movements']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expect(page.locator('tbody tr').first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Stock', exact: true }).click();
    await page.getByLabel('Only low stock').check();
    await expect(page.getByText('Low stock', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reports switch, chart and CSV export', async ({ page, errors }) => {
    await page.goto('/reports?report=sales');
    await expect(page.getByRole('heading', { level: 2, name: 'Sales' })).toBeVisible();
    await page.getByLabel('Period').selectOption('90d');
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
    await page.getByRole('button', { name: /Profit & loss/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Profit & loss' })).toBeVisible();
    await expect(page.getByText('Gross profit').first()).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV' }).first().click();
    expect((await download).suggestedFilename()).toMatch(/^pnl-.*\.csv$/);
    expect(errors).toEqual([]);
  });

  test('POS: sell a retail product', async ({ page, errors }) => {
    await page.goto('/pos');
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder('Search the catalogue').fill('Balm');
    await page.getByRole('button', { name: /Pain Relief Balm/ }).click();
    await expect(page.getByText('Total', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await expect(page.getByRole('heading', { name: /Invoice INV-/ })).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});

test.describe('role dashboards', () => {
  test('receptionist lands on the front desk', async ({ page, errors }) => {
    await login(page, 'reception@serenity.demo');
    await page.goto('/dashboard');
    await expect(page.getByText('Waiting in queue')).toBeVisible();
    await expect(page.getByText('Unpaid invoices', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('accountant lands on accounts', async ({ page, errors }) => {
    await login(page, 'accounts@serenity.demo');
    await page.goto('/dashboard');
    await expect(page.getByText('Collected this month')).toBeVisible();
    await expect(page.getByText(/Net cash this month/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('therapist sees their own performance', async ({ page, errors }) => {
    await login(page, 'arjun@serenity.demo');
    await page.goto('/dashboard');
    await expect(page.getByText('Commission this month')).toBeVisible();
    await expect(page.getByText('What customers said')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
