import { expect, login, test } from './fixtures';

test.describe('intelligence: AI assistant and advanced analytics', () => {
  test('owner asks the assistant and gets grounded answers', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');
    await page.goto('/assistant');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Assistant' })).toBeVisible();
    await expect(page.getByTestId('ai-suggestion')).toHaveCount(6);

    await page.getByTestId('ai-suggestion').filter({ hasText: 'Which services are growing?' }).click();
    const first = page.getByTestId('ai-answer').first();
    await expect(first.getByTestId('ai-headline')).toBeVisible({ timeout: 30_000 });
    await expect(first).toContainText('Service trends');
    await expect(first.locator('table tbody tr').first()).toBeVisible();
    await expect(first.getByRole('link', { name: /Service report/ })).toBeVisible();

    await page.getByLabel('Ask the assistant').fill('What time slots have the highest demand?');
    await page.getByLabel('Ask the assistant').press('Enter');
    const second = page.getByTestId('ai-answer').nth(1);
    await expect(second.getByTestId('ai-heatmap')).toBeVisible({ timeout: 30_000 });

    await second.getByRole('button', { name: 'Which services are growing?' }).click();
    await expect(page.getByTestId('ai-answer')).toHaveCount(3, { timeout: 30_000 });

    await page.getByLabel('Working branch').selectOption({ label: 'Serenity Indiranagar' });
    await expect(page.getByText(/for Serenity Indiranagar\./)).toBeVisible();
    await page.getByLabel('Ask the assistant').fill('How did revenue change last month?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByTestId('ai-answer').nth(3).getByTestId('ai-headline')).toContainText('Net sales', { timeout: 30_000 });
    await expect(page.getByTestId('ai-answer').nth(3).getByText('Compare branches')).toHaveCount(0);

    await page.getByLabel('Working branch').selectOption({ label: 'All branches' });
    await page.reload();
    await expect(page.getByRole('button', { name: /How did revenue change last month\?/ }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('analytics page renders every section and filters by branch', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
    await expect(page.getByTestId('analytics-kpis')).toContainText('Net sales');
    for (const id of ['analytics-trend', 'analytics-cohorts', 'analytics-services', 'analytics-therapists', 'analytics-acquisition', 'analytics-payments']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId('analytics-cohorts').locator('tbody tr')).toHaveCount(6);
    await page.getByRole('button', { name: 'Last 90 days' }).click();
    const allRevenue = await page.getByTestId('analytics-kpis').locator('p', { hasText: '₹' }).first().textContent();
    await page.getByLabel('Working branch').selectOption({ label: 'Serenity Koramangala' });
    await expect(page.getByTestId('analytics-kpis').locator('p', { hasText: '₹' }).first()).not.toHaveText(allRevenue ?? '');
    await expect(page.getByTestId('analytics-therapists').locator('tbody tr').first()).toBeVisible();
    await page.getByLabel('Working branch').selectOption({ label: 'All branches' });
    expect(errors).toEqual([]);
  });

  test('assistant is hidden from reception and plans without the feature', async ({ page, errors }) => {
    await login(page, 'reception@serenity.demo');
    await expect(page.getByRole('link', { name: 'AI Assistant' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Analytics' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
