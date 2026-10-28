import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The session view against the fake host (test/e2e-server.ts), whose scripted turns are paced so deltas
// arrive one by one: watch a turn stream in, stop at its approval and complete; send a message and see the
// optimistic turn reconcile, then steer the running turn; interrupt a running turn.

const AGENT_TEXT = 'Done. Created hello.txt in the current directory.'; // protocol example 28

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSession(page: Page, request: APIRequestContext, sessionId: string): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
}

test('a scripted turn streams in, waits for a decision, and completes', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation).toContainText('No turns yet');

  await request.post('/test/run', { data: { sessionId: 'ses_fake_3', text: 'Sketch the README.' } });
  const agent = conversation.locator('[data-item="agent"]');
  await expect(agent).toHaveAttribute('data-streaming', 'true');
  // The fixture's turn started long ago (its fixed time keeps "Worked for 10m 0s" below): any elapsed time.
  await expect(page.getByLabel('Session status')).toHaveText(/^Working · (\d+h \d+m|\d+m \d+s|\d+s)$/);
  // The text grows delta by delta until it is the whole message.
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const text = await agent.innerText();
        seen.add(text);
        return text;
      },
      { intervals: [20] },
    )
    .toBe(AGENT_TEXT);
  expect(seen.size).toBeGreaterThan(2);
  for (const text of seen) expect(AGENT_TEXT.startsWith(text)).toBe(true);
  await expect(agent).toHaveAttribute('data-streaming', 'false');

  // The command waits for an approval: the card is the call to action, the header's dot and word the one
  // status (no "1 approval waiting" line, no task-state line).
  const command = conversation.locator('[data-item="command"]');
  await expect(command).toContainText('Running echo hello > hello.txt');
  await expect(conversation.getByRole('group', { name: 'Approval: Run this command?' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Needs your decision' })).toHaveCount(0);
  await expect(page.getByLabel('Task state')).toHaveCount(0);
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');

  // Another device approves: the command runs, usage arrives, the turn completes. Its work folds behind
  // "1 previous message", the answer stays, "Worked for" closes the turn.
  await request.post('/test/resolve', { data: { sessionId: 'ses_fake_3', decision: 'accept' } });
  await expect(conversation.getByLabel('Approval answered')).toContainText('Approved on Mabue MacBook');
  await expect(page.getByLabel('Usage')).toHaveText('Session total 1,200 in · 340 out · context 4% full');
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
  await expect(command).toHaveCount(0);
  await expect(agent).toHaveText(AGENT_TEXT);
  await expect(conversation.getByText('Worked for 10m 0s')).toBeVisible();
  await conversation.getByRole('button', { name: '1 previous message' }).click();
  await expect(command).toContainText('Ran echo hello > hello.txt');
  await command.getByRole('button').click();
  await expect(command).toContainText('exit 0 · 42 ms');
});

test('a sent message shows as sending, reconciles with the host turn, and a steer joins the running turn', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const turns = conversation.locator('li[data-turn-status]');
  await expect(turns).toHaveCount(1);
  await expect(page.getByLabel('Session status')).toHaveText('Finished');

  await request.post('/test/delay', { data: { method: 'turn/start', ms: 1500 } });
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('List the files.\nInclude hidden ones.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(message).toHaveValue('');
  await expect(turns).toHaveCount(2);
  await expect(turns.last()).toHaveAttribute('data-turn-status', 'sending');
  await expect(turns.last()).toContainText('Sending…');

  // The host's turn replaces the optimistic one: still two turns, the message shown once.
  await expect(turns.last()).toHaveAttribute('data-turn-status', 'inProgress');
  await expect(turns).toHaveCount(2);
  await expect(conversation.getByText('List the files.\nInclude hidden ones.', { exact: true })).toHaveCount(1);
  await expect(turns.last()).not.toContainText('Sending…');

  // While the turn runs, send becomes steer.
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');
  await message.fill('Skip the hidden files after all.');
  await page.getByRole('button', { name: 'Steer' }).click();
  await expect(turns.last().getByText('Skip the hidden files after all.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Steering messages' })).toHaveCount(0);
  await expect(turns).toHaveCount(2);
});

test('interrupt stops a running turn', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Sketch the README.');
  await page.getByRole('button', { name: 'Send' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('[data-item="agent"]')).toHaveAttribute('data-streaming', 'true');
  // Running with an empty field: the round button is Stop.
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Steer' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop' }).click();
  const turn = conversation.locator('li[data-turn-status]');
  await expect(turn).toHaveAttribute('data-turn-status', 'interrupted');
  await expect(turn).toContainText(/Stopped after \d+/);
  await expect(page.getByLabel('Session status')).toHaveText('Interrupted');
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Needs your decision' })).toHaveCount(0);
  await expect(conversation.locator('[data-item="agent"]')).not.toHaveText(AGENT_TEXT); // stopped mid-stream
});

test('the steer composer fits a 390 px phone: placeholder on one line, Stop and Steer visible', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Message' });
  await expect(message).toHaveAttribute('placeholder', 'Message the agent…');
  await message.fill('Sketch the README.');
  await page.getByRole('button', { name: 'Send' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('[data-item="agent"]')).toHaveAttribute('data-streaming', 'true');

  // A running turn: the empty box shows the steer placeholder next to Stop.
  await expect(message).toHaveValue('');
  await expect(message).toHaveAttribute('placeholder', 'Steer the turn…');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeInViewport();
  const clipped = () => message.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(await clipped()).toBeLessThanOrEqual(0);
  // Typing into it: Steer, with the small Stop still next to it.
  await message.fill('x');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Steer' })).toBeInViewport();
  await message.fill('');
  await page.locator('footer.composer-bar').screenshot({ path: test.info().outputPath('steer-composer-390.png') });

  // The iPhone's system font is wider than headless Chromium's; widen the glyphs until even the short
  // placeholder overflows the box. It must truncate on its one line, not wrap into a clipped second line.
  await message.evaluate((el) => (el.style.letterSpacing = '8px'));
  expect(await clipped()).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeInViewport();
  await page.locator('footer.composer-bar').screenshot({ path: test.info().outputPath('steer-composer-390-wide-font.png') });
});
