import { mkdir } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page } from './worker-host';

// Settings, host section at 390 x 844: "Keep this Mac awake while plugged in" (protocol-v1.md section 4).
// The fake host reports `keepAwake` in host/status, applies host/settings/update and broadcasts
// host/status/changed; /test/power plays the Mac being unplugged, /test/keep-awake sets the starting state
// (or an older host without the field). Screenshots go to /tmp/keep-awake/.

const SHOTS = '/tmp/keep-awake';

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pairAndOpenSettings(page: Page, request: APIRequestContext): Promise<void> {
  await page.goto('/'); // not /pair: a later /pair#code would then be a hash change, not a page load
  await page.evaluate(() => localStorage.clear());
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
}

const section = (page: Page) => page.getByRole('region', { name: 'This Mac' });
const keepAwake = (page: Page) => page.getByRole('switch', { name: 'Keep this Mac awake while plugged in' });
const statusLine = (page: Page) => section(page).locator('#keep-awake-status');

test('the switch and its three status lines: Active, On battery, Off', async ({ page, request }) => {
  await pairAndOpenSettings(page, request);
  await expect(section(page)).toBeVisible();
  await expect(keepAwake(page)).toHaveAttribute('aria-checked', 'true');
  await expect(statusLine(page)).toHaveText('Active');
  await expect(section(page)).toContainText('With the lid closed and no external display, the Mac sleeps anyway.');
  await section(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/1-active-390.png` });

  // Unplugged: the host's power poll sends host/status/changed.
  await request.post('/test/power', { data: { onBattery: true } });
  await expect(statusLine(page)).toHaveText('On battery: the Mac may sleep');
  await expect(keepAwake(page)).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: `${SHOTS}/2-on-battery-390.png` });

  // Turned off from the phone: one host/settings/update, the switch and the line follow.
  await keepAwake(page).click();
  await expect(keepAwake(page)).toHaveAttribute('aria-checked', 'false');
  await expect(statusLine(page)).toHaveText('Off');
  const last = (await (await request.post('/test/last', { data: { method: 'host/settings/update' } })).json()) as { params: unknown };
  expect(last.params).toEqual({ keepAwake: 'off' });
  await page.screenshot({ path: `${SHOTS}/3-off-390.png` });

  // The section fits the phone: no sideways scroll, the switch is a full touch target.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = await keepAwake(page).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);

  // Back on, plugged in again.
  await request.post('/test/power', { data: { onBattery: false } });
  await keepAwake(page).click();
  await expect(statusLine(page)).toHaveText('Active');
  expect(((await (await request.post('/test/last', { data: { method: 'host/settings/update' } })).json()) as { params: unknown }).params).toEqual({
    keepAwake: 'pluggedIn',
  });
});

test('the setting the host reports after a reload is the one shown', async ({ page, request }) => {
  await pairAndOpenSettings(page, request);
  await keepAwake(page).click();
  await expect(statusLine(page)).toHaveText('Off');
  await page.reload();
  await expect(keepAwake(page)).toHaveAttribute('aria-checked', 'false');
  await expect(statusLine(page)).toHaveText('Off');
});

test('an older host without keepAwake shows no host section', async ({ page, request }) => {
  await request.post('/test/keep-awake', { data: { supported: false } });
  await pairAndOpenSettings(page, request);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Providers', level: 2 })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  await expect(keepAwake(page)).toHaveCount(0);
});
