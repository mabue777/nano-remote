import { expect, test, type Page } from '@playwright/test';

// The "new version" prompt against the built app, with builds deployed in turn on one origin
// (POST /test/new-build serves sw.js under another version). Reload must land on the newest build
// within ~2 s, also when a newer build lands while one is already waiting, and must never leave a dead
// greyed button (iPhone report 2026-10-25).

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset'); // also serves the built sw.js again
});

const shellCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith('nano-remote-shell-')));

/** Opens the app under the built worker (build A). */
async function openBuildA(page: Page) {
  await page.goto('/pair');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
}

/** The app coming back to the foreground: UpdatePrompt re-checks sw.js on visibilitychange. */
const foreground = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** Resolves once `version` is installed and waiting (nothing installing any more). */
async function waitingFor(page: Page, version: string) {
  await expect
    .poll(() =>
      page.evaluate(async (cache) => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.waiting?.state === 'installed' && registration.installing === null && (await caches.keys()).includes(cache);
      }, `nano-remote-shell-${version}`),
    )
    .toBe(true);
}

/** Taps Reload and answers how long the page took to load again. */
async function tapReload(page: Page): Promise<number> {
  const started = Date.now();
  await Promise.all([page.waitForEvent('load', { timeout: 5_000 }), page.getByRole('alertdialog', { name: 'New version' }).getByRole('button', { name: 'Reload' }).click()]);
  return Date.now() - started;
}

test('build B deployed under an open build A: the prompt appears and Reload loads B within 2 s', async ({ page, request }) => {
  await openBuildA(page);
  await request.post('/test/new-build', { data: { version: '00000000000000bb' } });
  await foreground(page);
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toBeVisible();

  expect(await tapReload(page)).toBeLessThan(2_000);
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toHaveCount(0);
  await expect.poll(() => shellCaches(page)).toEqual(['nano-remote-shell-00000000000000bb']);
});

test('build C lands while B is waiting: Reload loads C, not B', async ({ page, request }) => {
  await openBuildA(page);
  await request.post('/test/new-build', { data: { version: '00000000000000bb' } });
  await foreground(page);
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toBeVisible();
  await waitingFor(page, '00000000000000bb');

  await request.post('/test/new-build', { data: { version: '00000000000000cc' } });
  await foreground(page);
  await waitingFor(page, '00000000000000cc'); // B is redundant now

  expect(await tapReload(page)).toBeLessThan(2_000);
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toHaveCount(0);
  await expect.poll(() => shellCaches(page)).toEqual(['nano-remote-shell-00000000000000cc']);
});

test('build B already waiting when the page opens, then C lands: Reload loads C', async ({ page, request }) => {
  await openBuildA(page);
  await request.post('/test/new-build', { data: { version: '00000000000000bb' } });
  await foreground(page);
  await waitingFor(page, '00000000000000bb');
  await page.reload(); // a reload under the old worker leaves B waiting; the new page offers it at once
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toBeVisible();

  await request.post('/test/new-build', { data: { version: '00000000000000cc' } });
  await foreground(page);
  await waitingFor(page, '00000000000000cc');

  expect(await tapReload(page)).toBeLessThan(2_000);
  await expect.poll(() => shellCaches(page)).toEqual(['nano-remote-shell-00000000000000cc']);
});

test('a new worker that never takes over: Reload still reloads within 2 s and never leaves a dead button', async ({ page, request }) => {
  await openBuildA(page);
  await request.post('/test/new-build', { data: { version: '00000000000000bb', stuck: true } });
  await foreground(page);
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toBeVisible();
  await waitingFor(page, '00000000000000bb');

  expect(await tapReload(page)).toBeLessThan(2_000); // the fallback reload; navigations are network first
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  // The stuck worker still waits, so the fresh page offers it again with a live button.
  await expect(page.getByRole('alertdialog', { name: 'New version' }).getByRole('button', { name: 'Reload' })).toBeEnabled();
});
