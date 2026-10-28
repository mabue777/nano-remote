import { expect, test, type APIRequestContext, type Page } from './worker-host';

// Approvals and questions (spec 5.3) against the fake host (test/e2e-server.ts): cards render from
// session/open's pending on open and after a reload, request/resolved from another device leaves the
// answered line "Approved on <device>", each approval kind shows its details and only the offered buttons, a blocking
// question pins to the bottom and sends answers keyed by question id, and the time from the
// approval/request event reaching the page to the approval/resolve response stays under 1 s.

const DESKTOP = 'Mabue MacBook'; // the fake host's device/list name for dev_desktop

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pairAndOpen(page: Page, request: APIRequestContext, sessionId: string): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
}

async function lastParams(request: APIRequestContext, method: string): Promise<Record<string, unknown> | null> {
  return ((await (await request.post('/test/last', { data: { method } })).json()) as { params: Record<string, unknown> | null }).params;
}

const commandCard = (page: Page) => page.getByRole('group', { name: 'Approval: Run this command?' });

test('a pending approval renders on open and after a reload; another device answering leaves "Approved on <device>"', async ({ page, request }) => {
  await pairAndOpen(page, request, 'ses_fake_2'); // seeded waiting for its command approval
  const card = commandCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('echo hello > hello.txt');
  await expect(card).toContainText('/Users/me/Desktop/phone-test');
  await expect(card).toContainText('May I create hello.txt in the current directory?');
  await expect(card.getByRole('button')).toHaveText(['Accept', 'Decline', 'More']);
  await card.getByRole('button', { name: 'More' }).click();
  await expect(card.getByRole('group', { name: 'More choices' }).getByRole('button')).toHaveText(['Accept for this session', 'Cancel the turn']);

  // A reload is a new stream: session/open's pending brings the card back.
  await page.reload();
  await expect(commandCard(page)).toBeVisible();

  await request.post('/test/resolve', { data: { sessionId: 'ses_fake_2', decision: 'accept' } });
  await expect(commandCard(page)).toHaveCount(0);
  await expect(page.getByLabel('Approval answered')).toContainText(`Approved on ${DESKTOP}`);
  await expect(page.getByRole('alert', { name: 'Needs your decision' })).toHaveCount(0);
});

test('already_resolved: answering a card another device just answered turns it into the winner\'s line', async ({ page, request }) => {
  await pairAndOpen(page, request, 'ses_fake_2');
  await expect(commandCard(page)).toBeVisible();
  await request.post('/test/delay', { data: { method: 'approval/resolve', ms: 800 } });
  await commandCard(page).getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(commandCard(page).getByRole('button', { name: 'Sending…' })).toBeVisible();
  const requestId = (await commandCard(page).getAttribute('data-request-id'))!;
  await request.post('/test/resolve-request', { data: { sessionId: 'ses_fake_2', requestId, decision: 'accept' } });
  await expect(commandCard(page)).toHaveCount(0);
  await expect(page.getByLabel('Approval answered')).toContainText(`Approved on ${DESKTOP}`);
});

test('fileChange shows the paths with a diff preview; permission shows the reason; only offered buttons', async ({ page, request }) => {
  await pairAndOpen(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_3',
      request: {
        kind: 'fileChange',
        reason: 'Write the README and a note.',
        availableDecisions: ['accept', 'decline'],
        changes: [
          { path: 'README.md', kind: 'modify', diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Old\n+# Nano Remote\n' },
          { path: 'notes/todo.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+ship it\n' },
        ],
      },
    },
  });
  const files = page.getByRole('group', { name: 'Approval: Change 2 files?' });
  await expect(files).toBeVisible();
  await expect(files.getByRole('list', { name: 'Changed files' })).toContainText('README.md');
  await expect(files.getByRole('list', { name: 'Changed files' })).toContainText('notes/todo.txt');
  await expect(files.getByLabel('Diff of README.md')).toContainText('+# Nano Remote');
  await expect(files.getByLabel('Diff of README.md')).toContainText('-# Old');
  await expect(files).toContainText('Write the README and a note.');
  await expect(files.getByRole('button')).toHaveText(['Accept', 'Decline']);

  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_3',
      request: { kind: 'permission', permissions: { network: true }, scope: 'turn', reason: 'Needs network access to fetch packages.', availableDecisions: ['accept', 'cancel'] },
    },
  });
  const permission = page.getByRole('group', { name: 'Approval: Approval required' });
  await expect(permission).toContainText('Needs network access to fetch packages.');
  await expect(permission.getByRole('button')).toHaveText(['Accept', 'More']); // cancel sits behind More

  await files.getByRole('button', { name: 'Decline' }).click();
  await expect(files).toHaveCount(0);
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ sessionId: 'ses_fake_3', decision: 'decline' });
  await permission.getByRole('button', { name: 'More' }).click();
  await permission.getByRole('button', { name: 'Cancel the turn' }).click();
  await expect(permission).toHaveCount(0);
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ decision: 'cancel' });
  // Our own answers leave their lines where the cards were.
  await expect(page.getByLabel('Approval answered')).toHaveText([/Change 2 files\?.*Declined/, /Approval required.*Turn cancelled/]);
});

test('a blocking question pins to the bottom and sends answers keyed by question id', async ({ page, request }) => {
  await pairAndOpen(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_3',
      request: {
        kind: 'input',
        isBlocking: true,
        questions: [
          {
            id: 'sections',
            header: 'Sections',
            question: 'Which sections should the README have?',
            options: [
              { label: 'Install', description: 'How to install.' },
              { label: 'Usage', description: 'How to use it.' },
              { label: 'License', description: '' },
            ],
            multiSelect: true,
            isOther: true,
            isSecret: false,
          },
          { id: 'token', header: 'Token', question: 'Your npm token?', isOther: false, isSecret: true },
        ],
      },
    },
  });
  const pinned = page.getByRole('region', { name: 'Waiting for your answer' });
  const form = pinned.getByRole('group', { name: 'Question: 2 questions' });
  await expect(form).toBeVisible();
  // Pinned: outside the scrolling conversation, on the floating composer above its field; the conversation
  // scrolls behind both and keeps its end above them.
  await expect(page.getByRole('region', { name: 'Conversation' }).getByRole('group', { name: /^Question:/ })).toHaveCount(0);
  await expect(page.locator('footer.composer-bar').getByRole('region', { name: 'Waiting for your answer' })).toBeVisible();
  const pinnedBox = (await pinned.boundingBox())!;
  const composerBox = (await page.getByRole('textbox', { name: 'Message' }).boundingBox())!;
  expect(pinnedBox.y + pinnedBox.height).toBeLessThanOrEqual(composerBox.y);
  const bar = (await page.locator('footer.composer-bar').boundingBox())!;
  const space = () => page.locator('.conversation-content').evaluate((el) => parseFloat(getComputedStyle(el, '::after').height));
  await expect.poll(space).toBeGreaterThanOrEqual(bar.height - 1);

  const send = form.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await form.getByRole('checkbox', { name: /Usage/ }).check();
  await form.getByRole('checkbox', { name: /Install/ }).check();
  await form.getByText('Other…', { exact: true }).click();
  await form.getByRole('textbox', { name: 'Other answer to Sections' }).fill('FAQ');
  const secret = form.getByLabel('Answer to Token');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('npm_s3cret');
  await send.click();
  await expect(form).toHaveCount(0);
  expect(await lastParams(request, 'input/answer')).toMatchObject({
    sessionId: 'ses_fake_3',
    answers: { sections: ['Install', 'Usage', 'FAQ'], token: ['npm_s3cret'] },
  });
  // The secret never shows in the answered line.
  await expect(page.getByLabel('Question answered')).toContainText('Install, Usage, FAQ · ••••');
});

test('approval/request arriving to approval/resolve answered takes under 1 s', async ({ page, request }) => {
  // Timestamps taken in the page at the socket, before the app sees each message: when the
  // approval/request event arrives, and when the response to its approval/resolve arrives.
  await page.addInitScript(() => {
    const timing = { request: [] as { at: number; requestId: string }[], resolved: [] as { at: number; requestId: string; ok: boolean }[] };
    (window as unknown as { __approvalTiming: typeof timing }).__approvalTiming = timing;
    const resolving = new Map<unknown, string>();
    const Native = window.WebSocket;
    class Timed extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') return;
          const envelope = JSON.parse(event.data);
          if (envelope.type !== 'server_message') return;
          const message = envelope.message;
          if (message.method === 'approval/request') timing.request.push({ at: performance.now(), requestId: message.params.request.requestId });
          if (message.id !== undefined && resolving.has(message.id)) {
            timing.resolved.push({ at: performance.now(), requestId: resolving.get(message.id)!, ok: message.result?.ok === true });
          }
        });
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === 'string') {
          const envelope = JSON.parse(data);
          if (envelope.type === 'client_message' && envelope.message?.method === 'approval/resolve') resolving.set(envelope.message.id, envelope.message.params.requestId);
        }
        super.send(data);
      }
    }
    window.WebSocket = Timed;
  });
  await pairAndOpen(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('No turns yet');

  await request.post('/test/run', { data: { sessionId: 'ses_fake_3', text: 'Sketch the README.' } });
  await page.waitForFunction(() => (window as unknown as { __approvalTiming: { request: unknown[] } }).__approvalTiming.request.length > 0, null, {
    polling: 'raf',
    timeout: 15_000,
  });
  await commandCard(page).getByRole('button', { name: 'Accept', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { __approvalTiming: { resolved: unknown[] } }).__approvalTiming.resolved.length > 0, null, { polling: 'raf' });
  const timing = await page.evaluate(() => (window as unknown as { __approvalTiming: { request: { at: number; requestId: string }[]; resolved: { at: number; requestId: string; ok: boolean }[] } }).__approvalTiming);
  const arrived = timing.request[0]!;
  const resolved = timing.resolved[0]!;
  expect(resolved.requestId).toBe(arrived.requestId);
  expect(resolved.ok).toBe(true);
  const elapsedMs = resolved.at - arrived.at;
  test.info().annotations.push({ type: 'approval round trip', description: `${elapsedMs.toFixed(1)} ms` });
  console.log(`approval/request to approval/resolve response: ${elapsedMs.toFixed(1)} ms`);
  expect(elapsedMs).toBeLessThan(1000);
  await expect(commandCard(page)).toHaveCount(0);
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
});
