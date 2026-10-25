import { mkdir } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { sheetsSettled } from './sheets';

// The floating composer with sending (docs/research/new-look-prototype.md, adoption step 3; technique 6) at
// 390 x 844 against the fake host and the fake provider: a send shows the bubble at once, not dimmed, rising
// out of the card while the field clears; the round button is Send or Stop; typing into a running turn shows
// the hint, a Steer button and a small Stop, and the steer reaches the host; attachments sit in the card;
// local chat sends and stops with the same card; the transcript's end stays above the card. Screenshots in
// light and dark go to /tmp/step3-shots/ (not kept in the repo).

const SHOTS = '/tmp/step3-shots';
const SESSION = 'ses_fake_3'; // Codex, no turns yet; a sent message streams, then waits for an approval

const LONG = Array.from({ length: 24 }, (_, i) => `Step ${i + 1}: read the parser, found the off-by-one, and checked case ${i + 1}.`).join(' ');

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSession(page: Page, request: APIRequestContext, sessionId = SESSION): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
  await expect(page.locator('footer.composer-bar')).toBeVisible();
}

const lastParams = async (request: APIRequestContext, method: string) =>
  ((await (await request.post('/test/last', { data: { method } })).json()) as { params: Record<string, unknown> | null }).params;

/** Records every animation started on a user message row, from the page, with the properties it animates. */
async function watchRises(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[][] = [];
    (window as unknown as { rises: string[][] }).rises = seen;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      if (this.matches('.item-row.user, .steer, .chat-message.user') && Array.isArray(keyframes)) {
        seen.push([...new Set(keyframes.flatMap((frame) => Object.keys(frame)))].sort());
      }
      return original.call(this, keyframes, options);
    };
  });
}

/** Waits until the element's animations (its rise) are done. */
const settled = (row: Locator) => row.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));

const rises = (page: Page) => page.evaluate(() => (window as unknown as { rises: string[][] }).rises);

test('send: the bubble shows at once and full strength, rising out of the card, while the field clears', async ({ page, request }) => {
  await openSession(page, request);
  await request.post('/test/delay', { data: { method: 'turn/start', ms: 1500 } });
  await watchRises(page);
  const message = page.getByRole('textbox', { name: 'Message' });
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled(); // the greyed arrow while empty
  await message.fill('Sketch the README.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(message).toHaveValue('');
  const turn = page.locator('li[data-turn-status]').last();
  await expect(turn).toHaveAttribute('data-turn-status', 'sending');
  const bubble = turn.locator('.msg.user');
  await expect(bubble).toHaveText('Sketch the README.');
  // Not dimmed while it is being sent: once it has risen it is at full strength, still sending.
  await settled(turn.locator('.item-row.user'));
  await expect(turn).toHaveAttribute('data-turn-status', 'sending');
  expect(await bubble.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await turn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // It rose: one entrance on the user row, animating transform and opacity only.
  expect(await rises(page)).toEqual([['opacity', 'transform']]);
  await expect(turn).toHaveAttribute('data-turn-status', 'inProgress');
});

test('Send and Stop swap: arrow when idle, square while running, Steer with a small Stop while typing into the run', async ({ page, request }) => {
  await openSession(page, request);
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Sketch the README.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-item="agent"]')).toHaveAttribute('data-streaming', 'true');

  // Running, empty field: one round Stop.
  const card = page.locator('form.composer-card');
  await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Steer' })).toHaveCount(0);
  await expect(page.getByText('Steers the running turn')).toHaveCount(0);

  // Typing: the hint above the card, Steer at the right and a small Stop next to it.
  await message.fill('Keep it short.');
  await expect(page.locator('.composer-hint')).toHaveText('Steers the running turn');
  const steer = card.getByRole('button', { name: 'Steer' });
  const stop = card.getByRole('button', { name: 'Stop' });
  await expect(steer).toBeEnabled();
  await expect(stop).toHaveClass(/small/);
  const steerBox = (await steer.boundingBox())!;
  const stopBox = (await stop.boundingBox())!;
  expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(steerBox.x);
  expect(stopBox.width).toBeLessThan(steerBox.width);

  // Cleared again: Stop alone; it stops the turn and the arrow comes back.
  await message.fill('');
  await expect(page.locator('.composer-hint')).toHaveCount(0);
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByLabel('Session status')).toHaveText('Interrupted');
  await expect(card.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('steer while running: the hint says so, Steer delivers turn/steer into the running turn and the field clears', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_1');
  await request.post('/test/delay', { data: { method: 'turn/start', ms: 300 } });
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('List the files.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval'); // the turn runs, waiting

  await watchRises(page);
  await message.fill('Skip the hidden files after all.');
  await expect(page.locator('.composer-hint')).toHaveText('Steers the running turn');
  await page.getByRole('button', { name: 'Steer' }).click();
  await expect(message).toHaveValue('');
  await expect(page.locator('.composer-hint')).toHaveCount(0);
  await expect.poll(() => lastParams(request, 'turn/steer')).toMatchObject({ input: [{ type: 'text', text: 'Skip the hidden files after all.' }] });
  await expect(page.locator('li[data-turn-status]').last().getByText('Skip the hidden files after all.', { exact: true })).toBeVisible();
  expect((await rises(page)).length).toBeGreaterThanOrEqual(1);
});

test('stop with background tasks running asks first, from the round Stop', async ({ page, request }) => {
  const now = Math.floor(Date.now() / 1000);
  await request.post('/test/background', {
    data: { sessionId: 'ses_fake_1', tasks: [{ id: 'toolu_a', title: 'Review the parser', status: 'running', startedAt: now - 30 }] },
  });
  await openSession(page, request, 'ses_fake_1');
  await page.getByRole('textbox', { name: 'Message' }).fill('How is the review going?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('form.composer-card').getByRole('button', { name: 'Stop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop the turn?' });
  await expect(dialog).toContainText('This also cancels 1 background task');
  await dialog.getByRole('button', { name: 'Keep running' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await lastParams(request, 'turn/interrupt')).toBeNull();
});

test('attachments: the round + picks files, the chips sit inside the card, one is removed, the rest is sent', async ({ page, request }) => {
  await openSession(page, request);
  const add = page.locator('form.composer-card').getByRole('button', { name: 'Attach photos or files' });
  await expect(add).toBeVisible();
  const addBox = (await add.boundingBox())!;
  const fieldBox = (await page.getByRole('textbox', { name: 'Message' }).boundingBox())!;
  expect(addBox.x).toBeLessThan(fieldBox.x); // at the left of the field
  await page.locator('input.composer-file').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\n') },
    { name: 'build.log', mimeType: 'text/plain', buffer: Buffer.from('error\n') },
  ]);
  const tray = page.locator('form.composer-card').getByRole('list', { name: 'Attachments to send' });
  await expect(tray.locator('li[data-state="ready"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(tray.locator('li')).toHaveCount(1);
  // An attachment alone is something to send.
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(tray).toHaveCount(0);
  const params = (await lastParams(request, 'turn/start')) as { input: { type: string; name?: string }[] };
  expect(params.input).toEqual([expect.objectContaining({ type: 'file', name: 'build.log' })]);
});

test('the last message stays above the card: the transcript scrolls behind it, the jump pill sits above it', async ({ page, request }) => {
  await openSession(page, request);
  await request.post('/test/run', { data: { sessionId: SESSION, text: 'Fix the parser.', answer: LONG, deltas: 4 } });
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');
  await request.post('/test/resolve', { data: { sessionId: SESSION, decision: 'accept' } });
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const fromBottom = () => conversation.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
  await expect.poll(fromBottom).toBeLessThanOrEqual(1);
  const card = (await page.locator('form.composer-card').boundingBox())!;
  const conversationBox = (await conversation.boundingBox())!;
  // The conversation runs under the card (it scrolls behind it) ...
  expect(conversationBox.y + conversationBox.height).toBeGreaterThan(card.y);
  // ... and its last row ends above the card.
  const last = await page.locator('.conversation-content > *:last-child').evaluate((el) => {
    const rows = [...el.querySelectorAll('[data-flip-key], .msg, .turn-state')];
    return Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
  });
  expect(last).toBeLessThanOrEqual(card.y);
  const answer = page.locator('[data-item="agent"]').last();
  expect((await answer.boundingBox())!.y + (await answer.boundingBox())!.height).toBeLessThanOrEqual(card.y);

  // Scrolled up: the jump pill shows above the card.
  await conversation.dispatchEvent('touchstart');
  await conversation.evaluate((el) => (el.scrollTop = 0));
  await conversation.dispatchEvent('touchend');
  const pill = page.getByRole('button', { name: 'Jump to latest' });
  await expect(pill).toBeVisible();
  const pillBox = (await pill.boundingBox())!;
  expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(card.y);
});

// ---- local chat ------------------------------------------------------------------------------------------

const PROVIDER = {
  id: 'prv_cloud',
  name: 'Fake Cloud',
  baseURL: 'https://api.fake-provider.test:4174/v1',
  kind: 'openai-compatible',
  apiKeyFingerprint: 'sk-fak',
  models: { list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' }], lastProbedAt: 1 },
  hiddenModels: [],
  pinnedModels: [],
  supportsTools: 'unknown',
  refresh: { mode: 'manual' },
};

async function openChat(page: Page): Promise<void> {
  await page.goto('/pair');
  await page.evaluate((provider) => {
    localStorage.clear();
    localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [provider], defaultProviderId: provider.id }));
    localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { [provider.id]: 'sk-fake-key' } }));
    const at = Date.now();
    localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [{ id: 'chat_one', title: 'A chat', providerId: provider.id, model: 'fake-reasoner', createdAt: at, updatedAt: at, messages: [] }] }));
  }, PROVIDER);
  await page.goto('/c/chat_one');
  await expect(page.locator('footer.composer-bar')).toBeVisible();
}

test('local chat: the same card; Send rises the message and clears the field, Stop replaces it while the reply streams', async ({ page }) => {
  await openChat(page);
  await watchRises(page);
  const card = page.locator('form.composer-card');
  await expect(card.getByRole('button', { name: 'Attach photos or files' })).toHaveCount(0); // no attachments here
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Count slowly, please.');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(message).toHaveValue('');
  const mine = page.locator('.chat-message.user');
  await expect(mine).toHaveText('Count slowly, please.');
  await settled(mine);
  expect(await mine.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await rises(page)).toEqual([['opacity', 'transform']]);
  await expect(page.locator('.chat-message.assistant .msg.agent')).toHaveText('Hey');
  // Streaming: Stop is the button, also while typing (local chat sends one message at a time).
  await expect(card.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await message.fill('next');
  await expect(card.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('Stopped');
  await expect(card.getByRole('button', { name: 'Send' })).toBeEnabled();
});

// ---- screenshots ------------------------------------------------------------------------------------------

test('screenshots, light and dark: session idle, typed, running, steering, attachments; local chat idle and streaming', async ({ page, request }) => {
  test.setTimeout(120_000);
  await mkdir(SHOTS, { recursive: true });
  const shot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await sheetsSettled(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/${scheme}-${name}.png`, animations: 'disabled', caret: 'hide' });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await openSession(page, request);
  await expect(page.getByText('No turns yet. Send a message to start.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach photos or files' })).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Message' });
  await shot('1-session-idle');
  await message.fill('Sketch the README with install and usage.');
  await shot('2-session-typed');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-item="agent"]')).toHaveAttribute('data-streaming', 'true');
  await shot('3-session-running-stop');
  await message.fill('Keep it short.');
  await shot('4-session-running-steer');
  await message.fill('');
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');
  await request.post('/test/resolve', { data: { sessionId: SESSION, decision: 'accept' } });
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
  await page.locator('input.composer-file').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\n') },
    { name: 'build.log', mimeType: 'text/plain', buffer: Buffer.from('error\n') },
  ]);
  await expect(page.locator('li[data-state="ready"]')).toHaveCount(2);
  await shot('5-session-attachments');

  await openChat(page);
  await shot('6-chat-idle');
  await page.getByRole('textbox', { name: 'Message' }).fill('Count slowly, please.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.chat-message.assistant .msg.agent')).toHaveText('Hey');
  await shot('7-chat-streaming');
});
