import { mkdirSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { closeDetails, openDetails, sheetsSettled } from './sheets';

// The centred session header (look step 5, docs/research/new-look-prototype.md item 8) against the fake host
// (test/e2e-server.ts) at 390 x 844: one bar two lines high (round back, centred title, one status line,
// round ⋯); the status line is the screen's one status, with a live elapsed time while a turn runs, the
// approval wait, and "Mac offline" with the retry countdown when the host drops the socket; the ⋯ sheet holds
// what the old header showed plus Changes, Archive and Delete; Settings' back names Home's title.
// Screenshots, light and dark, go to /tmp/step5-shots/ for the operator (not into the repo).
const SHOTS = '/tmp/step5-shots';
const DIFF = { files: [{ path: 'hello.txt', kind: 'add', diff: '--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n' }] };

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

const status = (page: Page) => page.getByLabel('Session status');

/** Light and dark screenshots of the page, once nothing moves. */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await sheetsSettled(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png`, animations: 'disabled', caret: 'hide' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The seconds in "Working · 1m 5s" or "Working · 5s". */
async function elapsedSeconds(line: Locator): Promise<number> {
  const match = /^Working · (?:(\d+)m )?(\d+)s$/.exec((await line.textContent()) ?? '');
  return match === null ? -1 : Number(match[1] ?? 0) * 60 + Number(match[2]);
}

test('the header is one bar two lines high: round back, the title, one status line, round ⋯; nothing else above the conversation', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_1');
  const nav = page.locator('header.nav');
  await expect(nav.getByRole('heading', { level: 1 })).toHaveText('Create hello.txt and list files');
  await expect(status(page)).toHaveText('Finished');
  await expect(status(page)).toHaveAttribute('data-status', 'idle');
  await expect(nav.locator('.nav-footnote')).toHaveText('Finished'); // the status only: no folder, model or tag
  await expect(nav.getByRole('link', { name: 'Sessions', exact: true })).toHaveAttribute('href', '/');
  await expect(nav.getByRole('link', { name: 'Sessions', exact: true })).toHaveText('');
  await expect(nav.getByRole('button', { name: 'Session details' })).toBeVisible();

  // One status on the page, one h1, none of the old head.
  await expect(page.getByLabel('Session status')).toHaveCount(1);
  await expect(page.locator('.status-word')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('.session-head')).toHaveCount(0);
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('header.nav')!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('header.nav .round-button')].map((el) => el.getBoundingClientRect());
    const title = document.querySelector('header.nav h1')!.getBoundingClientRect();
    const conversation = document.querySelector('.conversation')!.getBoundingClientRect();
    return {
      height: bar.height,
      buttons: buttons.map((b) => [Math.round(b.width), Math.round(b.height)]),
      titleCentre: title.x + title.width / 2,
      gap: conversation.top - bar.bottom,
      background: getComputedStyle(document.querySelector('header.nav')!).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      position: getComputedStyle(document.querySelector('header.nav')!).position,
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(56); // 44 px buttons, two text lines (22 + 18), 8 px under
  expect(geometry.buttons).toEqual([
    [44, 44],
    [44, 44],
  ]);
  expect(Math.abs(geometry.titleCentre - 195)).toBeLessThanOrEqual(1);
  expect(geometry.gap).toBeLessThanOrEqual(1);
  expect(geometry.background).toBe(geometry.page);
  expect(geometry.position).toBe('sticky');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shoot(page, '1-header-idle');

  // The round back is still a link: a tap goes Home.
  await nav.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('a long title stays on one line and ends in an ellipsis', async ({ page, request }) => {
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheetsSettled(page);
  await sheet.getByLabel('Title (optional)').fill('A very long session title that cannot possibly fit on one line of the phone');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  const title = page.locator('header.nav h1');
  const fit = await title.evaluate((el) => ({ lines: Math.round(el.getBoundingClientRect().height / 22), truncated: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }));
  expect(fit).toEqual({ lines: 1, truncated: true, ellipsis: 'ellipsis' });
});

test('running: "Working" with a live elapsed time; it stops at the approval ("Needs approval") and after the turn', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_3');
  await expect(status(page)).toHaveText('Idle');
  await request.post('/test/run', { data: { sessionId: 'ses_fake_3', text: 'Write a long answer.', answer: 'word '.repeat(120), deltas: 60, startedAt: 'now' } });
  await expect(status(page)).toHaveText(/^Working · \d+s$/);
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  const first = await elapsedSeconds(status(page));
  await expect.poll(() => elapsedSeconds(status(page)), { timeout: 5_000 }).toBeGreaterThan(first); // it ticks
  await shoot(page, '2-header-running');

  // The scripted turn ends at an approval: the word only, no timer, and it stays put.
  await expect(status(page)).toHaveText('Needs approval', { timeout: 20_000 });
  await expect(status(page)).toHaveAttribute('data-status', 'waiting_approval');
  await expect(page.getByLabel('Session status')).toHaveCount(1);
  await expect(page.locator('.status-word')).toHaveCount(1); // the card adds no second status
  await shoot(page, '3-header-needs-approval');
  await page.waitForTimeout(1_500);
  await expect(status(page)).toHaveText('Needs approval');

  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(status(page)).toHaveText('Finished');
  await page.waitForTimeout(1_500);
  await expect(status(page)).toHaveText('Finished');
});

test('the Mac drops the socket: "Mac offline" with the retry countdown, first; back to the session\'s status once it returns', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_2');
  await expect(status(page)).toHaveText('Needs approval');
  await request.post('/test/offline', { data: { on: true } });
  await expect(status(page)).toHaveText(/^Mac offline · retrying in \d+ s$/);
  await expect(status(page)).toHaveAttribute('data-status', 'offline');
  await expect(status(page)).toHaveClass(/\berror\b/);
  const seconds = async () => Number(/retrying in (\d+) s/.exec((await status(page).textContent()) ?? '')?.[1] ?? -1);
  const before = await seconds();
  await expect.poll(seconds, { timeout: 4_000 }).not.toBe(before); // the countdown counts
  await expect(page.locator('.status-word')).toHaveCount(1);
  await shoot(page, '4-header-offline');

  await request.post('/test/offline', { data: { on: false } });
  await expect(status(page)).toHaveText('Needs approval', { timeout: 15_000 });
  await expect(status(page)).toHaveAttribute('data-status', 'waiting_approval');
});

test('a Full-access session: " · Full access" after the status, and in the ⋯ sheet', async ({ page, request }) => {
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheetsSettled(page);
  await sheet.getByRole('switch', { name: 'Bypass approvals (full access)' }).click();
  await sheet.getByLabel('Title (optional)').fill('Full access session');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await expect(page.locator('.nav-footnote')).toHaveText(/ · Full access$/);
  await expect(page.locator('.status-word')).toHaveCount(1);
  await shoot(page, '5-header-full-access');
  const details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toContainText('Full access');
  await closeDetails(page, details);
});

test('the ⋯ sheet: Status, Agent, Model, Folder, Permissions, Changes, then Archive and Delete; Model and Changes open their sheets', async ({ page, request }) => {
  await request.post('/test/turn-diff', { data: { sessionId: 'ses_fake_1', result: DIFF } });
  await pair(page, request);
  await page.goto('/s/ses_fake_1');
  await expect(status(page)).toHaveText('Finished');
  const details = await openDetails(page);
  await expect(details).toHaveAccessibleName('Create hello.txt and list files');
  await expect(details.locator('.detail-subtitle')).toHaveText(/ · [^·]+$/); // host · folder
  const rows = details.getByRole('list', { name: 'Session details' }).locator(':scope > li');
  await expect(rows.locator('.group-label')).toHaveText(['Status', 'Agent', 'Model', 'Folder', 'Permissions', 'Changes']);
  await expect(details.locator('[data-row="status"] .group-value')).toHaveText(/^Finished · Worked for \d+/);
  await expect(details.locator('[data-row="agent"] .group-value')).toHaveText('Codex');
  await expect(details.getByLabel('Model', { exact: true })).toHaveText('gpt-5-codex');
  await expect(details.locator('[data-row="folder"] .group-value')).toHaveText(/^\//); // the full path
  await expect(details.locator('[data-row="permissions"] .group-value')).toHaveText('Asks before running');
  await expect(details.locator('[data-row="changes"] .group-value')).toHaveText('1 file changed');
  const actions = details.getByRole('list', { name: 'Session actions' }).getByRole('button');
  await expect(actions).toHaveText(['Archive', 'Delete…']);
  await expect(details.getByRole('button', { name: 'Delete…' })).toHaveClass(/\berror\b/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shoot(page, '6-details-sheet');

  // Model row: the settings sheet.
  await details.getByTitle('Change model and effort').click();
  const settings = page.getByRole('dialog', { name: 'Model and effort' });
  await expect(settings).toBeVisible();
  await sheetsSettled(page);
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings).toHaveCount(0);
  await sheetsSettled(page);

  // Changes row: the last turn's Changes sheet.
  const again = await openDetails(page);
  await again.getByRole('button', { name: /Changes/ }).click();
  const changes = page.getByRole('dialog', { name: 'Changes' });
  await expect(changes.locator('.detail-subtitle')).toHaveText('1 file changed');
});

test('a session without changes has no Changes row; an archived one offers Unarchive', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_3');
  let details = await openDetails(page);
  await expect(details.locator('[data-row="changes"]')).toHaveCount(0);
  await details.getByRole('button', { name: 'Archive' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: /^Archived/ }).click();
  await page.getByRole('list', { name: 'Archived sessions' }).getByRole('link', { name: /Sketch the README/ }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_3$/);
  details = await openDetails(page);
  await expect(details.getByRole('list', { name: 'Session actions' }).getByRole('button')).toHaveText(['Unarchive', 'Delete…']);
});

test('Settings\' back names Home\'s title: "Sessions" with a host, and goes there', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/settings');
  const back = page.locator('a.back');
  await expect(back).toHaveText('Sessions');
  await back.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
});
