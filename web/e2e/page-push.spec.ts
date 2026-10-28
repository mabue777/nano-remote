import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { swipeLeft } from './gestures';

// Page push and the edge back swipe (motion technique 2, routes/PageStack.tsx) against the fake host at
// 390 x 844. Chromium has View Transitions, so a push or pop marks <html data-nav="push|pop"> while it plays;
// one test removes startViewTransition to run the Web Animations fallback, which keeps the page left on screen
// ([data-page-role="under"] beneath a push, "over" above a pop). A recorder installed before the app loads
// notes every data-nav value and every set of page roles, so short-lived states are not missed.

const WAITING = 'Run the test suite'; // ses_fake_2
const FINISHED = 'Create hello.txt and list files'; // ses_fake_1

test.beforeEach(async ({ page, request }) => {
  await request.post('/test/reset');
  await page.addInitScript(() => {
    const w = window as unknown as { navLog: string[]; roleLog: string[] };
    w.navLog = [];
    w.roleLog = [];
    const roles = () => [...document.querySelectorAll('[data-page-role]')].map((el) => el.getAttribute('data-page-role')).join(',');
    const observer = new MutationObserver(() => {
      const nav = document.documentElement.dataset.nav;
      if (nav !== undefined && w.navLog[w.navLog.length - 1] !== nav) w.navLog.push(nav);
      const now = roles();
      if (now !== '' && w.roleLog[w.roleLog.length - 1] !== now) w.roleLog.push(now);
    });
    // The init script can run before the document has its root element.
    const start = () => observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true, attributeFilter: ['data-nav', 'data-page-role'] });
    if (document.documentElement !== null) start();
    else document.addEventListener('readystatechange', start, { once: true });
  });
});

const sessions = (page: Page) => page.getByRole('list', { name: 'Sessions', exact: true });
const row = (page: Page, title: string) => sessions(page).getByRole('link', { name: new RegExp(title) });
const navLog = (page: Page) => page.evaluate(() => (window as unknown as { navLog: string[] }).navLog);
const roleLog = (page: Page) => page.evaluate(() => (window as unknown as { roleLog: string[] }).roleLog);
const clearLogs = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { navLog: string[]; roleLog: string[] };
    w.navLog = [];
    w.roleLog = [];
  });
const top = (page: Page) => page.locator('.page[data-page-role="top"]');
const settled = async (page: Page) => {
  await expect(page.locator('html')).not.toHaveAttribute('data-nav', /.*/);
  await expect(page.locator('[data-page-role="under"], [data-page-role="over"]')).toHaveCount(0);
};

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
  await expect(sessions(page).getByRole('link')).toHaveCount(3);
  // Room to scroll Home (three sessions fit on one screen).
  await page.addStyleTag({ content: 'main.home { padding-bottom: 1600px !important; }' });
}

/** A one-finger touch drag as touch events, `paceMs` between moves; lifts unless `lift` is false. */
async function touchDrag(page: Page, target: Locator, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6, paceMs = 8, lift = true): Promise<void> {
  const point = (x: number, y: number) => [{ identifier: 1, clientX: x, clientY: y }];
  await target.dispatchEvent('touchstart', { touches: point(from.x, from.y), changedTouches: point(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await target.dispatchEvent('touchmove', { touches: point(x, y), changedTouches: point(x, y) });
    await page.waitForTimeout(paceMs);
  }
  if (lift) await target.dispatchEvent('touchend', { touches: [], changedTouches: point(to.x, to.y) });
}

async function openSession(page: Page, title = WAITING): Promise<void> {
  await row(page, title).click();
  await expect(page).toHaveURL(/\/s\//);
  await expect(top(page).locator('main.session-screen')).toBeVisible();
  await settled(page);
}

test('a session slides in over Home and Back slides it out; Home comes back where it was scrolled, history steps back', async ({ page, request }) => {
  await pair(page, request);
  await page.evaluate(() => window.scrollTo(0, 120));
  await clearLogs(page);

  await openSession(page);
  expect(await navLog(page)).toEqual(['push']);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(top(page)).toHaveClass(/page-pushed/);

  await clearLogs(page);
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await settled(page);
  expect(await navLog(page)).toEqual(['pop']);
  expect(await page.evaluate(() => window.scrollY)).toBe(120);
  // Back stepped back through history: the session is still the next entry.
  await page.goForward();
  await expect(page).toHaveURL(/\/s\/ses_fake_2$/);
  await settled(page);

  // Settings is pushed too.
  await page.goBack();
  await settled(page);
  await clearLogs(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await settled(page);
  expect(await navLog(page)).toEqual(['push']);
});

test("the browser's back button pops once; a page change between Home's tabs does not slide", async ({ page, request }) => {
  await pair(page, request);
  await openSession(page);
  await clearLogs(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await settled(page);
  expect(await navLog(page)).toEqual(['pop']);

  await clearLogs(page);
  await page.getByRole('tab', { name: 'Chats' }).click();
  await expect(page).toHaveURL(/\/chats$/);
  await page.waitForTimeout(100);
  expect(await navLog(page)).toEqual([]);
});

test('an edge swipe past the threshold goes back with Home following the finger; a short one snaps back', async ({ page, request }) => {
  await pair(page, request);
  await page.evaluate(() => window.scrollTo(0, 80));
  await openSession(page);
  const pushed = top(page);

  // A drag that starts away from the edge does nothing.
  await touchDrag(page, pushed, { x: 120, y: 400 }, { x: 380, y: 405 });
  await expect(page).toHaveURL(/\/s\//);
  expect(await roleLog(page)).not.toContain('under,top');

  // A short, slow drag from the edge: Home shows beneath, shifted left and dimmed, then the page snaps back.
  await touchDrag(page, pushed, { x: 10, y: 400 }, { x: 60, y: 402 }, 10, 40, false);
  const under = page.locator('.page[data-page-role="under"]');
  await expect(under.locator('main.home')).toHaveCount(1);
  await expect(under).toHaveAttribute('inert', '');
  const pose = await under.evaluate((el) => ({ transform: el.style.transform, opacity: Number(el.style.opacity) }));
  expect(pose.transform).toMatch(/^translateX\(-\d+(\.\d+)?px\)$/);
  expect(pose.opacity).toBeGreaterThan(0.85);
  expect(pose.opacity).toBeLessThan(0.9);
  expect(await under.evaluate((el) => el.scrollTop)).toBe(80); // Home where it was left
  await expect(pushed).toHaveAttribute('data-swipe', 'drag');
  expect(await pushed.evaluate((el) => el.style.transform)).toBe('translateX(50px)');
  await pushed.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 60, clientY: 402 }] });
  await expect(under).toHaveCount(0);
  await expect(page).toHaveURL(/\/s\//);
  await expect(pushed).not.toHaveAttribute('data-swipe', /.*/);
  expect(await pushed.evaluate((el) => el.style.transform)).toBe('');

  // Past the threshold: the page slides away and Home is the page, without a second slide.
  await clearLogs(page);
  await touchDrag(page, pushed, { x: 10, y: 400 }, { x: 300, y: 405 }, 8, 16);
  await expect(page).toHaveURL(/\/$/);
  await settled(page);
  expect(await navLog(page)).toEqual([]);
  expect(await page.evaluate(() => window.scrollY)).toBe(80);
  // Home is fully alive again: the row swipe and pull-to-refresh still work.
  await expect(top(page)).not.toHaveAttribute('inert', /.*/);
  await swipeLeft(row(page, FINISHED));
  await expect(page.getByRole('button', { name: `Archive ${FINISHED}` })).toBeVisible();
  await page.getByRole('button', { name: `Archive ${FINISHED}` }).click();
  await expect(row(page, FINISHED)).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const main = page.locator('main.home');
  const touch = (y: number) => ({ touches: [{ identifier: 1, clientX: 200, clientY: y }], changedTouches: [{ identifier: 1, clientX: 200, clientY: y }] });
  await main.dispatchEvent('touchstart', touch(200));
  await main.dispatchEvent('touchmove', touch(260));
  await main.dispatchEvent('touchmove', touch(420));
  await expect(page.getByText('Release to refresh')).toBeVisible();
  await main.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 200, clientY: 420 }] });
  await expect(page.getByText('Release to refresh')).toHaveCount(0);
});

test('a vertical drag from the edge stays a scroll, and no swipe starts while a sheet is open', async ({ page, request }) => {
  await pair(page, request);
  await openSession(page);
  await touchDrag(page, top(page), { x: 10, y: 300 }, { x: 14, y: 600 }, 8, 16);
  await expect(page).toHaveURL(/\/s\//);
  expect(await roleLog(page)).not.toContain('under,top');

  await page.getByRole('button', { name: 'Session details' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await touchDrag(page, top(page), { x: 10, y: 400 }, { x: 300, y: 405 }, 8, 16);
  await expect(page).toHaveURL(/\/s\//);
  expect(await roleLog(page)).not.toContain('under,top');
});

test('without View Transitions the Web Animations fallback keeps the page left on screen while the two slide', async ({ page, request }) => {
  await page.addInitScript(() => {
    delete (Document.prototype as { startViewTransition?: unknown }).startViewTransition;
  });
  await pair(page, request);
  await clearLogs(page);
  await openSession(page);
  expect(await navLog(page)).toEqual(['push']);
  expect(await roleLog(page)).toContain('under,top');
  await clearLogs(page);
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await settled(page);
  expect(await navLog(page)).toEqual(['pop']);
  expect(await roleLog(page)).toContain('top,over');
});

test('with Reduce Motion pages change at once', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pair(page, request);
  await clearLogs(page);
  await openSession(page);
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await navLog(page)).toEqual([]);
  expect(await roleLog(page)).toEqual(['top']);
});
