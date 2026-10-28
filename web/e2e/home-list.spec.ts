import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { swipeLeft } from './gestures';

// Home as the flat session list (look step 6, docs/research/new-look-prototype.md item 6) against the fake
// host: the large "Sessions" title with the round +, the status filter chips (kept across a reload), one sign
// per row, and list changes through FLIP (technique 8): a row whose status changes slides to its new place
// (the hook marks it data-flip-anim="move"), an archived row fades out and the rows under it close up.
// Pull-to-refresh and the load-more sentinel still work. With STEP6A_SHOTS set, the last test writes light
// and dark screenshots there (Home All, Home Needs you, Home empty, the chats panel).

const FINISHED = 'Create hello.txt and list files'; // ses_fake_1
const WAITING = 'Run the test suite'; // ses_fake_2, waiting for an approval
const FRESH = 'Sketch the README'; // ses_fake_3, idle, on the second page (a day old)

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

const sessions = (page: Page) => page.getByRole('list', { name: 'Sessions', exact: true });
const row = (page: Page, title: string) => sessions(page).getByRole('link', { name: new RegExp(title) });
const item = (page: Page, sessionId: string) => sessions(page).locator(`li[data-flip-key="${sessionId}"]`);
const chips = (page: Page) => page.getByRole('group', { name: 'Show' });
const chip = (page: Page, name: string) => chips(page).getByRole('button', { name, exact: true });

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
  // Page two arrives through the load-more sentinel at the list's end (infinite scroll).
  await expect(sessions(page).getByRole('link')).toHaveCount(3);
}

/** Exactly one sign in the row, of this kind; `word` is what it says (shown for needs, read out otherwise). */
async function expectSign(link: Locator, kind: 'spinner' | 'needs' | 'failed' | 'none', word: string): Promise<void> {
  await expect(link.locator('.row-sign')).toHaveCount(1);
  await expect(link.locator('.row-sign')).toHaveAttribute('data-sign', kind);
  await expect(link.locator('.row-sign .xfade-out')).toHaveCount(0); // the cross-fade has settled
  if (kind === 'needs') await expect(link.locator('.row-sign')).toHaveText(word);
  else if (kind === 'none') await expect(link.locator('.row-sign .visually-hidden')).toHaveText(word);
  else await expect(link.locator('.row-sign').getByRole('img', { name: word })).toBeVisible();
}

const titles = async (page: Page) => (await sessions(page).locator('li:not(.list-leaving) .session-title').allTextContents()).map((t) => t.trim());

test('one sign per row, the status chips and their subsets (kept across a reload), and a status change slides its row', async ({ page, request }) => {
  await pair(page, request);
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Host' })).toHaveCount(0); // the host card is in Settings
  await expect(chips(page).getByRole('button')).toHaveText(['All', 'Running', 'Needs you', 'Finished']); // no counts
  await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, FINISHED).locator('.session-meta')).toHaveText(/^Codex · \S+ · 10 min ago$/);

  // Needs approval (dot and word), finished (nothing), idle (nothing).
  expect(await titles(page)).toEqual([WAITING, FINISHED, FRESH]);
  await expectSign(row(page, WAITING), 'needs', 'Needs approval');
  await expectSign(row(page, FINISHED), 'none', 'Finished');
  await expectSign(row(page, FRESH), 'none', 'Idle');

  // The idle session starts running: it moves above the finished one, and FLIP slid it there.
  await request.post('/test/status', { data: { sessionId: 'ses_fake_3', status: 'running' } });
  await expect.poll(() => titles(page)).toEqual([WAITING, FRESH, FINISHED]);
  await expectSign(row(page, FRESH), 'spinner', 'Working');
  await expect(item(page, 'ses_fake_3')).toHaveAttribute('data-flip-anim', 'move');
  await expect(item(page, 'ses_fake_1')).toHaveAttribute('data-flip-anim', 'move');

  // Each chip shows its subset; the switch animates like any list change.
  await chip(page, 'Running').click();
  await expect(chip(page, 'Running')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => titles(page)).toEqual([FRESH]);
  await chip(page, 'Needs you').click();
  await expect.poll(() => titles(page)).toEqual([WAITING]);
  await chip(page, 'Finished').click();
  await expect.poll(() => titles(page)).toEqual([FINISHED]);
  await expect(sessions(page).locator('li.list-leaving')).toHaveCount(0); // the left rows faded out and went

  // The chip lasts across a reload.
  await page.reload();
  await expect(chip(page, 'Finished')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => titles(page)).toEqual([FINISHED]);

  // The running session fails (its agent stops): "!" in the error tone, and it is now under Finished.
  await request.post('/test/status', { data: { sessionId: 'ses_fake_3', status: 'error' } });
  await expect.poll(() => titles(page)).toEqual([FINISHED, FRESH]);
  await expectSign(row(page, FRESH), 'failed', 'Error');

  // A question for it: "Needs your answer", under Needs you.
  await request.post('/test/request', {
    data: { sessionId: 'ses_fake_3', request: { kind: 'input', isBlocking: true, questions: [{ id: 'q', header: '', question: 'Which branch?', options: [], isOther: true, isSecret: false }] } },
  });
  await request.post('/test/status', { data: { sessionId: 'ses_fake_3', status: 'waiting_input' } });
  await chip(page, 'Needs you').click();
  await expect.poll(() => titles(page)).toEqual([WAITING, FRESH]); // newest first within the same rank
  await expectSign(row(page, FRESH), 'needs', 'Needs your answer');
  await expectSign(row(page, WAITING), 'needs', 'Needs approval');

  await chip(page, 'All').click();
  await expect.poll(() => titles(page)).toEqual([WAITING, FRESH, FINISHED]);
});

test('archive: the row fades out and the rows under it close up; pull-to-refresh lists again', async ({ page, request }) => {
  await pair(page, request);
  expect(await titles(page)).toEqual([WAITING, FINISHED, FRESH]);
  const before = (await item(page, 'ses_fake_3').boundingBox())!.y;

  await swipeLeft(row(page, FINISHED));
  await page.getByRole('button', { name: `Archive ${FINISHED}` }).click();
  await expect(item(page, 'ses_fake_1')).toHaveCount(0);
  await expect(sessions(page).locator('li.list-leaving')).toHaveCount(0);
  await expect.poll(() => titles(page)).toEqual([WAITING, FRESH]);
  await expect(item(page, 'ses_fake_3')).toHaveAttribute('data-flip-anim', 'move'); // it closed the gap
  await expect.poll(async () => (await item(page, 'ses_fake_3').boundingBox())!.y).toBeLessThan(before - 30);
  await expect(page.getByRole('button', { name: 'Archived (1)' })).toBeVisible(); // a plain row that expands
  await page.getByRole('button', { name: 'Archived (1)' }).click();
  await expect(page.getByRole('list', { name: 'Archived sessions' }).getByRole('link', { name: new RegExp(FINISHED) })).toBeVisible();

  // The host's row changed without telling the phone (no session/updated): only a pull shows it.
  await request.post('/test/touch', { data: { sessionId: 'ses_fake_3', agoSeconds: 5 } });
  await expect(row(page, FRESH).locator('.session-meta')).toContainText('1 d ago');
  await page.evaluate(() => window.scrollTo(0, 0));
  const main = page.locator('main.home');
  const touch = (y: number) => ({ touches: [{ identifier: 1, clientX: 200, clientY: y }], changedTouches: [{ identifier: 1, clientX: 200, clientY: y }] });
  await main.dispatchEvent('touchstart', touch(200));
  await main.dispatchEvent('touchmove', touch(260));
  await main.dispatchEvent('touchmove', touch(420));
  await expect(page.getByText('Release to refresh')).toBeVisible();
  await main.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 200, clientY: 420 }] });
  await expect(row(page, FRESH).locator('.session-meta')).toContainText('just now');
});

test('with Reduce Motion the list changes at once: no row leaves slowly, nothing slides', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pair(page, request);
  await request.post('/test/status', { data: { sessionId: 'ses_fake_3', status: 'running' } });
  await expect.poll(() => titles(page)).toEqual([WAITING, FRESH, FINISHED]);
  await chip(page, 'Running').click();
  await expect(sessions(page).locator('li')).toHaveCount(1); // the others went at once, no fading copies
  await expect(sessions(page).locator('[data-flip-anim]')).toHaveCount(0);
  await expect(sessions(page).locator('.xfade')).toHaveCount(0); // the status word simply changes
  await chip(page, 'All').click();
});

test('screenshots, light and dark: Home (All), Home (Needs you), Home empty, chats panel', async ({ page, request }) => {
  const out = process.env.STEP6A_SHOTS;
  test.skip(out === undefined || out === '', 'set STEP6A_SHOTS to capture');
  const shot = (name: string) => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', caret: 'hide' });
  for (const scheme of ['light', 'dark'] as const) {
    await request.post('/test/reset');
    await page.emulateMedia({ colorScheme: scheme });
    await pair(page, request);
    await chip(page, 'All').click();
    await request.post('/test/status', { data: { sessionId: 'ses_fake_3', status: 'running' } });
    await expect.poll(() => titles(page)).toEqual([WAITING, FRESH, FINISHED]);
    await swipeLeft(row(page, FINISHED));
    await page.getByRole('button', { name: `Archive ${FINISHED}` }).click();
    await page.locator('.undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => titles(page)).toEqual([WAITING, FRESH, FINISHED]);
    await expect(page.locator('.undo-toast')).toHaveCount(0);
    await page.waitForTimeout(400); // the list changes settle
    await shot(`${scheme}-1-home-all`);
    await chip(page, 'Needs you').click();
    await expect.poll(() => titles(page)).toEqual([WAITING]);
    await page.waitForTimeout(400);
    await shot(`${scheme}-2-home-needs-you`);
    await chip(page, 'All').click();

    // Empty: a host with no sessions at all.
    await request.post('/test/delete-all');
    await page.reload();
    await expect(page.getByText('No sessions yet. Start one to drive an agent from here.')).toBeVisible();
    await shot(`${scheme}-3-home-empty`);

    // The chats panel with two chats.
    await page.evaluate(() => {
      const at = Date.now();
      const provider = {
        id: 'prv_cloud',
        name: 'Fake Cloud',
        baseURL: 'https://api.fake-provider.test:4174/v1',
        kind: 'openai-compatible',
        apiKeyFingerprint: 'sk-fak',
        models: { list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: {}, source: 'vendor' }], lastProbedAt: 1 },
        hiddenModels: [],
        pinnedModels: [],
        supportsTools: 'unknown',
        refresh: { mode: 'manual' },
      };
      const chat = (id: string, title: string, minutes: number) => ({
        id,
        title,
        providerId: provider.id,
        model: 'fake-reasoner',
        createdAt: at - minutes * 60_000,
        updatedAt: at - minutes * 60_000,
        messages: [{ role: 'user', text: title, status: 'complete' }],
      });
      localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [provider], defaultProviderId: provider.id }));
      localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { prv_cloud: 'sk-fake-key' } }));
      localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [chat('c1', 'Explain the FLIP technique', 3), chat('c2', 'Draft a release note', 90)] }));
    });
    await page.getByRole('tab', { name: 'Chats' }).click();
    await page.reload();
    await expect(page.getByRole('list', { name: 'Chats' }).getByRole('link')).toHaveCount(2);
    await shot(`${scheme}-4-chats-panel`);
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await page.evaluate(() => localStorage.removeItem('nano-remote/chats/v1'));
  }
});
