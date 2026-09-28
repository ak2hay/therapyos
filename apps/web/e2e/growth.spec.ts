import { DEMO_TENANT, expect, login, test } from './fixtures';

test.describe('growth: feedback, marketing and notifications', () => {
  test('guest leaves low QR feedback and the owner is alerted', async ({ page, errors }) => {
    const comment = `E2E cold room ${Date.now()}`;
    await page.goto(`/feedback/${DEMO_TENANT}/ind`);
    await page.getByRole('radio', { name: '1 star', exact: true }).click();
    await page.getByPlaceholder('What could we do better? (optional)').fill(comment);
    await page.getByPlaceholder('Your name (optional)').fill('E2E Guest');
    await page.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(page.getByTestId('feedback-thanks')).toBeVisible();

    await login(page, 'owner@serenity.demo');
    await expect(page.getByTestId('unread-count')).toBeVisible();
    await page.goto('/feedback?maxRating=2');
    await expect(page.getByRole('heading', { level: 1, name: 'Feedback' })).toBeVisible();
    await expect(page.getByTestId('feedback-row').filter({ hasText: comment })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('feedback page shows summary and QR code', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');
    await page.goto('/feedback');
    await expect(page.getByText('Rating distribution')).toBeVisible();
    await expect(page.getByTestId('feedback-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'QR codes' }).click();
    await expect(page.getByTestId('feedback-qr')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('marketing: retention insights and campaign audience preview', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');
    await page.goto('/marketing');
    await expect(page.getByRole('heading', { level: 1, name: 'Marketing & Retention' })).toBeVisible();
    await expect(page.getByText('Repeat rate')).toBeVisible();
    await expect(page.getByTestId('cohort-table')).toBeVisible();

    await page.getByRole('button', { name: 'Customer segments', exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    await page.getByRole('button', { name: 'Campaigns', exact: true }).click();
    await expect(page.getByText('Monsoon wellness')).toBeVisible();
    await page.getByText('Monsoon wellness').click();
    await expect(page.getByText('Attributed revenue').or(page.getByText('Converted')).first()).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'New campaign' }).first().click();
    const preview = page.getByTestId('audience-preview');
    await expect(preview).toContainText(/\d+ customers will receive this/);
    await page.getByLabel('Audience segment').selectOption('VIP');
    await expect(preview).toContainText(/\d+ customers will receive this/);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('manager can read campaigns but not create them', async ({ page, errors }) => {
    await login(page, 'manager@serenity.demo');
    await page.goto('/marketing');
    await expect(page.getByRole('heading', { level: 1, name: 'Marketing & Retention' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New campaign' })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('settings: notification templates preview and delivery log', async ({ page, errors }) => {
    await login(page, 'owner@serenity.demo');
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Notifications', exact: true }).filter({ hasText: 'Notifications' }).click();
    await expect(page.getByText(/Appointment booked/i).first()).toBeVisible();
    await page.getByRole('button', { name: /^Edit APPOINTMENT_BOOKED/ }).first().click();
    await expect(page.getByTestId('template-preview')).not.toBeEmpty();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Delivery log', exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await expect(page.getByText(/reminders/i).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
});
