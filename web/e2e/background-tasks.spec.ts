import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { sheetsSettled } from './sheets';

// Background tasks on the phone (spec 5.1 Session.backgroundTasks, userMessage `queued`) against the fake
// host (test/e2e-server.ts) at 390 x 844: the home row's "N background tasks" badge, the session's strip
// (title, elapsed time, status; a tap shows the latest activity), a message that waits behind the tasks
// ("Queued: waiting for N background tasks to finish"), Stop asking first because it cancels them, an
// ended task leaving the strip 60 s after it ended (fake clock), and a stopped session showing none running.
// With BG_TASKS_OUT set, the last test also writes light and dark screenshots there.

const SESSION = 'ses_fake_1';
const TITLE = 'Create hello.txt and list files';
const out = process.env.BG_TASKS_OUT;

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Two subagents running (one with activity), one background command that finished. */
async function seedTasks(request: APIRequestContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await request.post('/test/background', {
    data: {
      sessionId: SESSION,
      tasks: [
        { id: 'toolu_a', title: 'Review the parser for edge cases', status: 'running', startedAt: now - 125, lastActivity: 'Running Read src/parser.ts' },
        { id: 'toolu_b', title: 'Check the docs for broken links', status: 'running', startedAt: now - 40 },
        { id: 'toolu_c', title: 'npm test', status: 'finished', startedAt: now - 70, endedAt: now - 20 },
      ],
    },
  });
}

async function openSession(page: Page): Promise<void> {
  await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`));
}

/** Sends a message from the composer; with tasks running the fake host queues it. */
async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

const lastInterrupt = async (request: APIRequestContext) =>
  ((await (await request.post('/test/last', { data: { method: 'turn/interrupt' } })).json()) as { params: unknown }).params;

test('home row: "2 background tasks" while two run, gone once none runs', async ({ page, request }) => {
  await seedTasks(request);
  await pair(page, request);
  const row = page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: new RegExp(TITLE) });
  await expect(row.getByText('2 background tasks')).toBeVisible();
  // The host reports the end live (session/updated): the badge goes without a reload.
  await request.post('/test/background', { data: { sessionId: SESSION, tasks: [] } });
  await expect(row.getByText(/background task/)).toHaveCount(0);
});

test('session strip: one row per task with title, elapsed time and status; a tap shows the latest activity', async ({ page, request }) => {
  await seedTasks(request);
  await pair(page, request);
  await openSession(page);
  const strip = page.getByRole('region', { name: /Background tasks/ });
  await expect(strip.getByRole('heading')).toHaveText('Background tasks · 2 running');
  const rows = strip.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Review the parser for edge cases');
  await expect(rows.nth(0)).toContainText(/2 min \d+ s/);
  await expect(rows.nth(0)).toContainText('Running');
  await expect(rows.nth(2)).toContainText('npm test');
  await expect(rows.nth(2)).toContainText('50 s');
  await expect(rows.nth(2)).toContainText('Finished');
  // The elapsed time counts up while it runs.
  const first = await rows.nth(1).locator('.bg-task-time').textContent();
  await expect(rows.nth(1).locator('.bg-task-time')).not.toHaveText(first ?? '', { timeout: 3_000 });

  const review = rows.nth(0).getByRole('button');
  await expect(review).toHaveAttribute('aria-expanded', 'false');
  await review.click();
  await expect(review).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(0)).toContainText('Running Read src/parser.ts');
  await rows.nth(1).getByRole('button').click();
  await expect(rows.nth(1)).toContainText('No activity reported yet.');
  await review.click();
  await expect(rows.nth(0)).not.toContainText('Running Read src/parser.ts');
});

test('a message sent while tasks run says it is queued, until the engine takes it', async ({ page, request }) => {
  await seedTasks(request);
  await pair(page, request);
  await openSession(page);
  await send(page, 'How are the reviews going?');
  const notice = page.getByRole('status').filter({ hasText: 'Queued' });
  await expect(notice).toHaveText('Queued: waiting for 2 background tasks to finish');
  await expect(page.getByText('Working…')).toHaveCount(0);
  await request.post('/test/take-queued', { data: { sessionId: SESSION } });
  await expect(notice).toHaveCount(0);
  await expect(page.getByText('the parser one is halfway')).toBeVisible();
});

test('Stop asks first while tasks run: "Keep running" stops nothing, "Stop anyway" stops the turn and the tasks', async ({ page, request }) => {
  await seedTasks(request);
  await pair(page, request);
  await openSession(page);
  await send(page, 'How are the reviews going?');
  await expect(page.getByText('Queued: waiting for 2 background tasks to finish')).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop the turn?' });
  await expect(dialog).toContainText('This also cancels 2 background tasks. Stop anyway?');
  await dialog.getByRole('button', { name: 'Keep running' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await lastInterrupt(request)).toBeNull();
  await expect(page.getByText('Queued: waiting for 2 background tasks to finish')).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('dialog', { name: 'Stop the turn?' }).getByRole('button', { name: 'Stop anyway' }).click();
  await expect(page.getByLabel('Session status')).toHaveText('Interrupted');
  expect(await lastInterrupt(request)).toMatchObject({ sessionId: SESSION });
  const strip = page.getByRole('region', { name: /Background tasks/ });
  await expect(strip.getByRole('heading')).toHaveText('Background tasks');
  await expect(strip.getByText('Cancelled')).toHaveCount(2);
});

test('an ended task leaves the strip 60 s after it ended, during the same turn; a running one stays (fake clock)', async ({ page, request }) => {
  const now = Math.floor(Date.now() / 1000);
  await page.clock.install({ time: now * 1000 });
  await request.post('/test/background', {
    data: {
      sessionId: SESSION,
      tasks: [
        { id: 'toolu_run', title: 'Watch the build', status: 'running', startedAt: now - 10 },
        { id: 'toolu_stop', title: 'Search everything', status: 'cancelled', startedAt: now - 30, endedAt: now - 5 },
      ],
    },
  });
  await pair(page, request);
  await openSession(page);
  const strip = page.getByRole('region', { name: /Background tasks/ });
  const rows = strip.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Search everything');
  await expect(rows.nth(1)).toContainText('Cancelled');
  // 45 s after the stop it is still shown; past 60 s it is gone without a new turn or a reload.
  await page.clock.fastForward(40_000);
  await expect(rows).toHaveCount(2);
  await page.clock.fastForward(25_000);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Watch the build');
  await expect(rows.nth(0)).toContainText('Running');
});

test('a session whose agent stopped never shows a task running: "Ended" in the strip, no home badge', async ({ page, request }) => {
  await seedTasks(request);
  await request.post('/test/status', { data: { sessionId: SESSION, status: 'error' } });
  await pair(page, request);
  const row = page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: new RegExp(TITLE) });
  await expect(row).toBeVisible();
  await expect(row.getByText(/background task/)).toHaveCount(0);
  await openSession(page);
  const strip = page.getByRole('region', { name: /Background tasks/ });
  await expect(strip.getByRole('heading')).toHaveText('Background tasks');
  await expect(strip.getByText('Ended')).toHaveCount(2);
  await expect(strip.getByText('Running', { exact: true })).toHaveCount(0);
  await expect(strip.getByText('Finished')).toHaveCount(1);
});

test('Stop without running tasks stops at once', async ({ page, request }) => {
  await pair(page, request);
  await openSession(page);
  await send(page, 'One more thing.');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => lastInterrupt(request)).toMatchObject({ sessionId: SESSION });
});

test('screenshots, light and dark: home badge, strip with a queued message, Stop confirmation', async ({ page, request }) => {
  test.skip(out === undefined || out === '', 'set BG_TASKS_OUT to capture');
  await seedTasks(request);
  await pair(page, request);
  const shot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await sheetsSettled(page); // no sheet mid-slide; animations: 'disabled' finishes the switch knob
    await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', caret: 'hide' });
  };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByText('2 background tasks')).toBeVisible();
    await shot(`home-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await openSession(page);
  await page.getByRole('region', { name: /Background tasks/ }).getByRole('button').first().click();
  await send(page, 'How are the reviews going?');
  await expect(page.getByText('Queued: waiting for 2 background tasks to finish')).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(`session-queued-${scheme}`);
  }
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('dialog', { name: 'Stop the turn?' })).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(`stop-confirm-${scheme}`);
  }
});
