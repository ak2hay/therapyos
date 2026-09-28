import { expect, type Page, test as base } from '@playwright/test';

export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? 'Demo@12345';
export const DEMO_TENANT = process.env.E2E_TENANT ?? 'serenity-wellness';

/** Collects uncaught page errors and console errors so specs can assert a page rendered cleanly. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (res) => {
    if (res.status() < 400 || res.request().resourceType() === 'document') return;
    // Before sign-in the app probes for an existing session; a 401 there is the expected answer.
    if (res.status() === 401 && res.url().endsWith('/auth/refresh')) return;
    errors.push(`http ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Failed requests are reported with their URL by the response listener; aborted navigations and dev-only noise are ignored.
    if (/Failed to load resource|net::ERR_ABORTED|Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('you@business.com').fill(email);
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const business = page.getByText('Business', { exact: true });
  if (await business.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('select').first().selectOption(DEMO_TENANT);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page).toHaveURL(/\/dashboard|\/today/, { timeout: 30_000 });
}

export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    await use(watchErrors(page));
  },
});
export { expect };
