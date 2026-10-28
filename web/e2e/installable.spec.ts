import { expect, test } from './worker-host';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset'); // also serves the built sw.js again
});

// Home-screen install (ADR 0004) against the built app: the manifest and icons are served, the service
// worker registers and caches the shell, and the shell at 390 x 844 pads by the safe-area insets.

test('the manifest and every icon it names are served', async ({ page, request }) => {
  await page.goto('/pair');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');

  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = (await response.json()) as { display: string; start_url: string; theme_color: string; icons: { src: string }[] };
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
  for (const src of new Set([...manifest.icons.map((icon) => icon.src), '/apple-touch-icon.png'])) {
    const icon = await request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()['content-type'], src).toBe('image/png');
  }
});

test('the service worker registers, controls the page and caches the shell but nothing under /v1', async ({ page }) => {
  await page.goto('/pair');
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { script: registration.active?.scriptURL ?? '', scope: registration.scope };
  });
  expect(registered.script).toMatch(/\/sw\.js$/);
  expect(new URL(registered.scope).pathname).toBe('/');

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.filter((key) => key.startsWith('nano-remote-shell-'));
    const paths = shell.length === 1 ? (await (await caches.open(shell[0]!)).keys()).map((r) => new URL(r.url).pathname) : [];
    return { keys: shell, paths };
  });
  expect(cached.keys).toHaveLength(1);
  expect(cached.keys[0]).toMatch(/^nano-remote-shell-[0-9a-f]{16}$/);
  expect(cached.paths).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/apple-touch-icon.png']));
  expect(cached.paths.some((p) => /^\/assets\/index-.+\.js$/.test(p))).toBe(true);
  expect(cached.paths.filter((p) => p.startsWith('/v1'))).toEqual([]);

  // A reload is served under the worker's control and still reaches the host for pairing.
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
});

test('the shell at 390 x 844 pads by the safe-area insets and never scrolls sideways', async ({ page }) => {
  await page.goto('/pair');
  const screen = page.locator('main.screen');
  await expect(screen).toBeVisible();
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

  // Phone defaults: no tap delay, no pinch or double-tap zoom, no text inflation on rotate.
  const root = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { touchAction: style.touchAction, textSizeAdjust: style.getPropertyValue('text-size-adjust') || style.getPropertyValue('-webkit-text-size-adjust') };
  });
  expect(root).toEqual({ touchAction: 'pan-x pan-y', textSizeAdjust: '100%' });

  // Desktop Chromium has no notch, so the insets are 0 and the shell keeps its base padding.
  const padding = () =>
    screen.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
    });
  expect(await padding()).toEqual(['12px', '20px', '24px', '20px']); // the 20 px page margin (--page-x)

  // Emulate a notched phone through the DevTools protocol: env(safe-area-inset-*) now reports an
  // iPhone 15's portrait insets (59 px top, 34 px bottom), plus side insets to cover landscape.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 59, right: 12, bottom: 34, left: 12 } } as never);
  await expect.poll(padding).toEqual(['71px', '32px', '58px', '32px']);
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeInViewport();
  const headingTop = await page.getByRole('heading', { name: 'Pair this phone' }).evaluate((el) => el.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(59); // below the notch, not under it

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a new build prompts to reload, and Reload switches the page to it', async ({ page, request }) => {
  await page.goto('/pair');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  const before = await page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith('nano-remote-shell-')));
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toHaveCount(0); // the first install is not an update

  // The host now serves a different build; the page checks for it (as it does on returning to the foreground).
  await request.post('/test/new-build', { data: { version: '0000000000000new' } });
  await page.evaluate(async () => void (await (await navigator.serviceWorker.ready).update()));

  const prompt = page.getByRole('alertdialog', { name: 'New version' });
  await expect(prompt).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible(); // the app keeps working meanwhile
  await Promise.all([page.waitForEvent('load'), prompt.getByRole('button', { name: 'Reload' }).click()]);

  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'New version' })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith('nano-remote-shell-'))))
    .toEqual(['nano-remote-shell-0000000000000new']);
  expect(before).not.toEqual(['nano-remote-shell-0000000000000new']);
});
