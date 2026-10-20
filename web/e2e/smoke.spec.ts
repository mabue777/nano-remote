import { expect, test } from '@playwright/test';

// Placeholder smoke: the built index page (host/public) loads and renders the app shell.
test('built index page loads and renders the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Nano Remote/);
  await expect(page.locator('#app h1')).toHaveText('Nano Remote');
});
