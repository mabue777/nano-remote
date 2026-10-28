import { mkdir } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

// The transcript in the new look with its motion (docs/research/new-look-prototype.md, adoption step 2):
// flat tool rows that open under themselves, "Thinking" before the first words, the paced answer, the
// "Worked for" hairline and the "N previous messages" fold, auto-scroll that lets go at the first touch with
// its jump pill, and a streamed answer that arrives whole: no delta lost or shown twice, also across a
// dropped socket (replay from the cursor) and a reload (snapshot of the running turn). Screenshots of the
// session and local chat in light and dark go to /tmp/step2-shots/ (not kept in the repo).

const SHOTS = '/tmp/step2-shots';
const SESSION = 'ses_fake_3';

/** A long answer, so the transcript overflows the phone and streams for a while. */
const LONG = Array.from(
  { length: 24 },
  (_, i) => `Step ${i + 1}: read the parser, found the off-by-one in the tokenizer, and checked the fix against case ${i + 1}.`,
).join(' ');

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSession(page: Page, request: APIRequestContext, sessionId = SESSION): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
}

const run = (request: APIRequestContext, data: Record<string, unknown> = {}) => request.post('/test/run', { data: { sessionId: SESSION, text: 'Fix the parser.', ...data } });

/** How far the conversation is scrolled from its bottom, in px. */
const fromBottom = (conversation: Locator) => conversation.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

/** Polls the agent message's text until it is `full`; returns every text seen on the way. */
async function watchText(agent: Locator, full: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const text = await agent.innerText();
        seen.add(text);
        return text;
      },
      { intervals: [20], timeout: 20_000 },
    )
    .toBe(full);
  return seen;
}

test('Thinking holds the answer\'s place, the answer streams in whole, then the turn folds behind "N previous messages"', async ({ page, request }) => {
  await openSession(page, request);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await run(request, { answer: LONG, deltas: 30 });

  // Before the first words: a grey shimmering "Thinking", no "Working…".
  const thinking = conversation.locator('.thinking');
  await expect(thinking).toHaveText('Thinking');
  await expect(conversation.getByText('Working…')).toHaveCount(0);
  expect(await thinking.evaluate((el) => getComputedStyle(el).animationName)).toBe('thinking-shimmer');

  // The answer streams in; every text on the way is a prefix of the whole, and it ends whole.
  const agent = conversation.locator('[data-item="agent"]');
  await expect(agent).toHaveAttribute('data-streaming', 'true');
  await expect(thinking).toHaveCount(0);
  const seen = await watchText(agent, LONG);
  expect(seen.size).toBeGreaterThan(5);
  for (const text of seen) expect(LONG.startsWith(text)).toBe(true);

  // The command waits for approval: its row, then the approval card, in view at the end of the content.
  const command = conversation.locator('[data-item="command"]');
  await expect(command).toContainText('Running echo hello > hello.txt');
  const card = page.getByRole('group', { name: /Approval/ });
  await expect(card).toBeInViewport();
  await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);

  // Approved elsewhere: the turn ends, its work folds, the answer stays, "Worked for" closes it.
  await request.post('/test/resolve', { data: { sessionId: SESSION, decision: 'accept' } });
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');
  const fold = conversation.getByRole('button', { name: '1 previous message' });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(command).toHaveCount(0);
  await expect(agent).toHaveText(LONG);
  await expect(conversation.locator('.worked-for')).toHaveText('Worked for 10m 0s');
  await expect(conversation.locator('.thinking')).toHaveCount(0);

  // The fold opens and closes; the command row opens its output under it and closes again.
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(command).toContainText('Ran echo hello > hello.txt');
  const row = command.getByRole('button', { name: 'Ran echo hello > hello.txt' });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(command.locator('.row-output')).toHaveText('Created hello.txt');
  await expect(command).toContainText('exit 0 · 42 ms');
  await expect(command.getByRole('button', { name: 'Full output' })).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(command.locator('.row-output')).toHaveCount(0);
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(command).toHaveCount(0);
});

test('auto-scroll follows the stream, lets go at the first touch with a jump pill, and a tap on it follows again', async ({ page, request }) => {
  await openSession(page, request);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const pill = page.getByRole('button', { name: 'Jump to latest' });
  await expect(pill).toHaveCount(0); // hidden from the accessibility tree while not shown
  await run(request, { answer: `${LONG} ${LONG} ${LONG}`, deltas: 120 });
  const agent = conversation.locator('[data-item="agent"]');

  // While at the bottom the view follows the growing answer.
  await expect.poll(() => conversation.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
  await expect.poll(() => fromBottom(conversation), { timeout: 3000 }).toBeLessThanOrEqual(60);
  await expect(agent).toHaveAttribute('data-streaming', 'true');

  // A finger lands and scrolls up: following stops, the pill fades in, and new text does not pull the view.
  await conversation.dispatchEvent('touchstart');
  await conversation.evaluate((el) => (el.scrollTop = 0));
  await conversation.dispatchEvent('touchend');
  await expect(pill).toBeVisible();
  await expect(page.locator('.jump-latest')).toHaveClass(/shown/);
  const grown = await conversation.evaluate((el) => el.scrollHeight);
  await expect.poll(() => conversation.evaluate((el) => el.scrollHeight)).toBeGreaterThan(grown);
  expect(await conversation.evaluate((el) => el.scrollTop)).toBe(0);

  // The pill glides back down and following resumes to the very end: the approval card is in view.
  await pill.click();
  await expect(page.locator('.jump-latest')).not.toHaveClass(/shown/);
  await expect(agent).toHaveAttribute('data-streaming', 'false', { timeout: 20_000 });
  await expect(page.getByRole('group', { name: /Approval/ })).toBeInViewport();
  await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);
});

test('a dropped socket mid-stream: the app replays from its cursor and the answer is whole, nothing doubled', async ({ page, request }) => {
  await openSession(page, request);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await run(request, { answer: LONG, deltas: 40 });
  const agent = conversation.locator('[data-item="agent"]');
  await expect(agent).toHaveAttribute('data-streaming', 'true');
  await expect.poll(async () => (await agent.innerText()).length).toBeGreaterThan(200);
  await request.post('/test/kill');
  const seen = await watchText(agent, LONG);
  for (const text of seen) expect(LONG.startsWith(text)).toBe(true);
  await expect(agent).toHaveAttribute('data-streaming', 'false');
  await expect(agent).toHaveText(LONG);
});

test('a reload mid-stream: the running turn comes back from the snapshot and streams on to the whole answer', async ({ page, request }) => {
  await openSession(page, request);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await run(request, { answer: LONG, deltas: 40 });
  const agent = conversation.locator('[data-item="agent"]');
  await expect.poll(async () => (await agent.innerText()).length).toBeGreaterThan(200);
  await page.reload();
  const seen = await watchText(conversation.locator('[data-item="agent"]'), LONG);
  for (const text of seen) expect(LONG.startsWith(text)).toBe(true);
  await expect(conversation.locator('[data-item="agent"]')).toHaveCount(1);
});

test('background tasks and thinking rows are flat rows that open under themselves', async ({ page, request }) => {
  await openSession(page, request);
  await request.post('/test/items', {
    data: {
      sessionId: SESSION,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Why does it fail?' }] },
        { type: 'reasoning', summary: 'Reading the tokenizer', text: 'The tokenizer drops the last character.' },
        { type: 'fileChange', changes: [{ path: 'src/parser.ts', kind: 'update', diff: '-a\n+b\n' }] },
        { type: 'agentMessage', text: 'Fixed the off-by-one.' },
      ],
    },
  });
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await conversation.getByRole('button', { name: '2 previous messages' }).click();
  const thought = conversation.locator('[data-item="reasoning"]').getByRole('button');
  await expect(thought).toHaveText('Thought Reading the tokenizer');
  await thought.click();
  await expect(conversation.locator('.reasoning-text')).toHaveText('The tokenizer drops the last character.');
  await expect(conversation.locator('[data-item="fileChange"]').getByRole('button').first()).toHaveText('Edited src/parser.ts');
});

// ---- screenshots, light and dark -----------------------------------------------------------------

const PROVIDER_PORT = 4174;
const CLOUD = {
  id: 'prv_cloud',
  name: 'Fake Cloud',
  baseURL: `https://api.fake-provider.test:${PROVIDER_PORT}/v1`,
  kind: 'openai-compatible',
  apiKeyFingerprint: 'sk-fak',
  models: { list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' }], lastProbedAt: 1 },
  hiddenModels: [],
  pinnedModels: [],
  supportsTools: 'unknown',
  refresh: { mode: 'manual' },
};

async function seedChat(page: Page, messages: unknown[]): Promise<void> {
  await page.goto('/pair');
  await page.evaluate(
    ({ provider, messages }) => {
      localStorage.clear();
      localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [provider], defaultProviderId: provider.id }));
      localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { [provider.id]: 'sk-fake-key' } }));
      const at = Date.now();
      const chat = { id: 'chat_long', title: 'A long chat', providerId: provider.id, model: 'fake-reasoner', createdAt: at, updatedAt: at, messages };
      localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [chat] }));
    },
    { provider: CLOUD, messages },
  );
}

const HISTORY = Array.from({ length: 8 }, (_, i) => [
  { role: 'user', text: `Question ${i + 1}: what does step ${i + 1} do?`, status: 'complete' },
  { role: 'assistant', text: `Step ${i + 1} reads the input.\n\n- It checks the length.\n- It **trims** the end.`, status: 'complete' },
]).flat();

test('local chat: lands at the end, Thinking shimmers before the answer, the view follows it, and the pill brings it back', async ({ page }) => {
  await seedChat(page, HISTORY);
  await page.goto('/c/chat_long');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.getByText('Question 8: what does step 8 do?')).toBeVisible();
  await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);

  await page.getByRole('textbox', { name: 'Message' }).fill('Say hi in three words.');
  await page.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('.chat-message.assistant').last();
  await expect(reply.locator('.shimmer')).toHaveText('Thinking');
  await expect(reply.locator('.msg.agent')).toHaveText('Hey there, friend!');
  await expect(reply.getByRole('button', { name: 'Thought' })).toBeVisible();
  await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);

  await conversation.dispatchEvent('touchstart');
  await conversation.evaluate((el) => (el.scrollTop = 0));
  await conversation.dispatchEvent('touchend');
  const pill = page.getByRole('button', { name: 'Jump to latest' });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);
  await expect(page.locator('.jump-latest')).not.toHaveClass(/shown/);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme}): session streaming, finished, unfolded, approval in view, local chat`, async ({ page, request }) => {
    await mkdir(SHOTS, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme });
    await openSession(page, request);
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await run(request, { answer: LONG, deltas: 60 });
    await expect(conversation.locator('.thinking')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${scheme}-1-thinking.png` });
    const agent = conversation.locator('[data-item="agent"]');
    await expect.poll(async () => (await agent.innerText()).length).toBeGreaterThan(600);
    await page.screenshot({ path: `${SHOTS}/${scheme}-2-streaming.png` });
    await expect(page.getByRole('group', { name: /Approval/ })).toBeInViewport({ timeout: 20_000 });
    await expect.poll(() => fromBottom(conversation)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOTS}/${scheme}-3-approval.png` });
    await request.post('/test/resolve', { data: { sessionId: SESSION, decision: 'accept' } });
    await expect(conversation.locator('.worked-for')).toBeVisible();
    await page.waitForTimeout(400); // the fold's slide settles
    await page.screenshot({ path: `${SHOTS}/${scheme}-4-finished.png` });
    await conversation.getByRole('button', { name: '1 previous message' }).click();
    await conversation.locator('[data-item="command"]').getByRole('button').click();
    await expect(conversation.locator('.row-output')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${scheme}-5-unfolded.png` });

    await seedChat(page, HISTORY);
    await page.goto('/c/chat_long');
    await page.getByRole('textbox', { name: 'Message' }).fill('Say hi in three words.');
    await page.getByRole('button', { name: 'Send' }).click();
    const reply = page.locator('.chat-message.assistant').last();
    await expect(reply.locator('.shimmer')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${scheme}-6-chat-thinking.png` });
    await expect(reply.locator('.msg.agent')).toHaveText('Hey there, friend!');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${scheme}-7-chat.png` });
  });
}

test('Reduce Motion: the answer shows as it arrives, no fading pieces, and "Thinking" stands still', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSession(page, request);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await run(request, { answer: LONG, deltas: 30 });
  const thinking = conversation.locator('.thinking');
  await expect(thinking).toBeVisible();
  expect(await thinking.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  const agent = conversation.locator('[data-item="agent"]');
  let pieces = 0;
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        pieces = Math.max(pieces, await agent.locator('.fresh').count());
        const text = await agent.innerText();
        seen.add(text);
        return text;
      },
      { intervals: [20], timeout: 20_000 },
    )
    .toBe(LONG);
  expect(pieces).toBe(0);
  for (const text of seen) expect(LONG.startsWith(text)).toBe(true);
});
