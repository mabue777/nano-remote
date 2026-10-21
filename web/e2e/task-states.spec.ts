import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Task states (roadmap Phase 3) against the fake host (test/e2e-server.ts): the home list puts sessions
// waiting for this user first whatever their age, the app icon badge counts pending requests (a stubbed
// navigator.setAppBadge records 1, then 0 once the approval is answered), the session header names the
// task state, and landing on a session with a pending request shows its card in the viewport.

const TITLES = ['Create hello.txt and list files', 'Run the test suite', 'Sketch the README'];

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Replaces the Badging API before the app loads; every call lands in window.__badge (a clear is 0). */
async function stubBadge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: number[] = [];
    (window as unknown as { __badge: number[] }).__badge = calls;
    Object.defineProperty(Navigator.prototype, 'setAppBadge', { configurable: true, value: async (n?: number) => void calls.push(n ?? 0) });
    Object.defineProperty(Navigator.prototype, 'clearAppBadge', { configurable: true, value: async () => void calls.push(0) });
  });
}

const badgeCalls = (page: Page) => page.evaluate(() => (window as unknown as { __badge: number[] }).__badge);

test('the session waiting for an approval comes first even when another one is newer, with the labels', async ({ page, request }) => {
  // The finished session becomes the newest: by age alone it would lead the list.
  await request.post('/test/touch', { data: { sessionId: 'ses_fake_1', agoSeconds: 5 } });
  await pair(page, request);
  const sessions = page.getByRole('list', { name: 'Sessions' });
  await expect(sessions.getByRole('link')).toHaveCount(3);
  await expect(sessions.getByRole('link')).toHaveText([new RegExp(TITLES[1]!), new RegExp(TITLES[0]!), new RegExp(TITLES[2]!)]);
  const waiting = sessions.getByRole('link', { name: new RegExp(TITLES[1]!) });
  await expect(waiting).toContainText('Needs approval');
  await expect(waiting.getByLabel('1 waiting for you')).toBeVisible();
  await expect(waiting).toHaveAttribute('data-tone', 'attention');
  const finished = sessions.getByRole('link', { name: new RegExp(TITLES[0]!) });
  await expect(finished).toContainText('Finished');
  await expect(finished).toHaveAttribute('data-tone', 'ok');
  await expect(finished).not.toContainText('Finished while away'); // first look: nothing to compare with
});

test('the app badge shows 1 for the pending approval and clears once it is answered', async ({ page, request }) => {
  await stubBadge(page);
  await pair(page, request);
  await expect.poll(() => badgeCalls(page)).toContain(1);

  await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: new RegExp(TITLES[1]!) }).click();
  await expect(page.getByLabel('Task state')).toHaveText('Waiting for your approval');
  const card = page.getByRole('group', { name: 'Approval: Run this command?' });
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await badgeCalls(page)).at(-1)).toBe(0);
  const calls = await badgeCalls(page);
  expect(calls.slice(calls.indexOf(1))).toEqual([1, 0]); // 1, then 0, nothing else after
  await expect(page.getByLabel('Task state')).toHaveText('Finished');
});

test('landing on a session with a pending request shows the card in the viewport', async ({ page, request }) => {
  await pair(page, request);
  // A long transcript, then an approval at its end: the card sits far below the first screen.
  const items = Array.from({ length: 30 }, (_, i) => ({ type: 'agentMessage', text: `Step ${i + 1}: ${'checked the build output and moved on. '.repeat(3)}` }));
  await request.post('/test/items', { data: { sessionId: 'ses_fake_3', items } });
  await request.post('/test/request', {
    data: { sessionId: 'ses_fake_3', request: { kind: 'command', command: 'pnpm test', cwd: '/Users/me/Desktop/phone-test', reason: 'Run the tests.', availableDecisions: ['accept', 'decline'] } },
  });

  // As a notification's link opens it: a fresh page load straight on /s/<id>.
  await page.goto('/s/ses_fake_3');
  const card = page.getByRole('group', { name: 'Approval: Run this command?' });
  await expect(card.getByRole('heading', { name: 'Run this command?' })).toBeInViewport();
  await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeInViewport();
  await expect(page.getByText('Step 1:')).not.toBeInViewport();
  await expect(page.getByLabel('Task state')).toHaveText('Finished'); // idle after its turn; the card is the call to action
});
