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
  await expect(page.getByLabel('Session status')).toHaveText('Working');
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

  // The command waits for an approval: the banner and the counters (the cards are a later step).
  const command = conversation.locator('[data-item="command"]');
  await expect(command).toContainText('Running');
  await expect(command).toContainText('echo hello > hello.txt');
  const banner = page.getByRole('alert', { name: 'Needs your decision' });
  await expect(banner).toBeVisible();
  await expect(banner.getByLabel('1 approval waiting')).toBeVisible();
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');

  // Another device approves: the command runs, usage arrives, the turn completes.
  await request.post('/test/resolve', { data: { sessionId: 'ses_fake_3', decision: 'accept' } });
  await expect(banner).toHaveCount(0);
  await expect(command).toContainText('Done');
  await expect(command).toContainText('echo hello > hello.txt · exit 0 · 42 ms');
  await expect(page.getByLabel('Usage')).toHaveText('1,200 in · 340 out · 4% of context');
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
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
  await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();

  await page.getByRole('button', { name: 'Interrupt' }).click();
  const turn = conversation.locator('li[data-turn-status]');
  await expect(turn).toHaveAttribute('data-turn-status', 'interrupted');
  await expect(turn).toContainText('Interrupted');
  await expect(page.getByLabel('Session status')).toHaveText('Interrupted');
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Needs your decision' })).toHaveCount(0);
  await expect(conversation.locator('[data-item="agent"]')).not.toHaveText(AGENT_TEXT); // stopped mid-stream
});
