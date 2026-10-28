import { expect, test, type APIRequestContext, type Page } from './worker-host';

import { sheetsSettled } from './sheets';

// Reference screenshots of every real screen at 390 x 844 against the fake host, in light and dark
// (<scheme>-<screen>.png), for before/after comparisons when styles change (the visual groundwork, the look
// adoption steps). Runs only when VISUAL_OUT names a folder:
// `VISUAL_OUT=/tmp/shots pnpm exec playwright test visual-capture`.
// Each screen waits for its content and lets animations finish, so two runs of the same build match.

const out = process.env.VISUAL_OUT;
test.skip(out === undefined || out === '', 'set VISUAL_OUT to capture');

const PROVIDER_PORT = 4174;
const CLOUD = {
  id: 'prv_cloud',
  name: 'Fake Cloud',
  baseURL: `https://api.fake-provider.test:${PROVIDER_PORT}/v1`,
  kind: 'openai-compatible',
  apiKeyFingerprint: 'sk-fak',
  models: {
    list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' }],
    lastProbedAt: 1,
  },
  hiddenModels: [],
  pinnedModels: [],
  supportsTools: 'unknown',
  refresh: { mode: 'manual' },
};

test.beforeEach(async ({ page, request }) => {
  await request.post('/test/reset');
  // Headless Chromium reports notifications as blocked; a phone that has not decided yet shows the Settings
  // switch, so the shots show that state.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', { value: { permission: 'default', requestPermission: async () => 'default' }, configurable: true, writable: true });
  });
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await sheetsSettled(page); // no sheet mid-slide; animations: 'disabled' finishes the switch knob
  await page.screenshot({ path: `${out}/${await scheme(page)}-${name}.png`, animations: 'disabled', caret: 'hide' });
}

async function scheme(page: Page): Promise<string> {
  return page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}

const CHANGES = [
  { path: 'src/new.ts', kind: 'add', diff: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n' },
  { path: 'src/app.ts', kind: 'modify', diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n import x from "x";\n-const a = 1;\n+const a = 2;\n export { a };\n' },
  { path: 'old.txt', kind: 'delete', diff: '--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test('pair', async ({ page }) => {
      await page.goto('/pair');
      await expect(page.getByRole('button', { name: 'Pair' })).toBeVisible();
      await shot(page, 'pair');
    });

    test('home', async ({ page, request }) => {
      await pair(page, request);
      await expect(page.getByRole('list', { name: 'Sessions' })).toBeVisible();
      await shot(page, 'home');
    });

    test('session', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_1');
      await expect(page.getByLabel('Session status')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
      await shot(page, 'session');
    });

    test('new-session-pi', async ({ page, request }) => {
      await pair(page, request);
      await page.getByRole('button', { name: 'New session' }).click();
      const sheet = page.getByRole('dialog', { name: 'New session' });
      await sheet.getByRole('radio', { name: 'Pi' }).click();
      await expect(sheet.getByRole('combobox', { name: 'Model' })).toHaveValue('llamacpp/bonsai-27b');
      await shot(page, 'new-session-pi');
    });

    test('settings', async ({ page, request }) => {
      await pair(page, request);
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Keep this Mac awake while plugged in' })).toBeVisible(); // the host section has loaded
      await shot(page, 'settings');
    });

    test('local-chat', async ({ page }) => {
      await page.goto('/pair');
      await page.evaluate((provider) => {
        localStorage.clear();
        localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [provider], defaultProviderId: provider.id }));
        localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { [provider.id]: 'sk-fake-key' } }));
        const at = 1760930100000;
        const chat = {
          id: 'chat_1',
          title: 'Say hi',
          providerId: provider.id,
          model: 'fake-reasoner',
          createdAt: at,
          updatedAt: at,
          messages: [
            { role: 'user', text: 'Say hi in three words.', status: 'complete' },
            { role: 'assistant', text: 'Hey there, friend!', status: 'complete' },
          ],
        };
        localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [chat] }));
      }, CLOUD);
      await page.goto('/c/chat_1');
      await expect(page.getByRole('switch', { name: 'Thinking' })).toBeVisible();
      await expect(page.getByText('Hey there, friend!')).toBeVisible();
      await shot(page, 'local-chat');
    });

    test('session-streaming', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_3');
      await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
      await request.post('/test/delay', { data: { method: 'approval/resolve', ms: 0 } });
      await request.post('/test/run', { data: { sessionId: 'ses_fake_3', text: 'Sketch the README.' } });
      await expect(page.locator('[data-item="agent"]')).toHaveAttribute('data-streaming', 'true');
      await page.screenshot({ path: `${out}/${await scheme(page)}-session-streaming.png`, caret: 'hide' });
      await expect(page.getByRole('group', { name: 'Approval: Run this command?' })).toBeVisible(); // the turn then waits
      await shot(page, 'session-after-stream');
    });

    test('approval', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_2'); // seeded waiting for its command approval
      await expect(page.getByRole('group', { name: 'Approval: Run this command?' })).toBeVisible();
      await shot(page, 'approval');
    });

    test('question', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_3');
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
                ],
                multiSelect: true,
                isOther: true,
                isSecret: false,
              },
            ],
          },
        },
      });
      const form = page.getByRole('region', { name: 'Waiting for your answer' }).getByRole('group', { name: /^Question:/ });
      await expect(form).toBeVisible();
      await form.getByText('Usage', { exact: true }).click();
      await shot(page, 'question');
    });

    // Look step 4: the quiet approval and question cards and their answered line.
    const addRequest = (request: APIRequestContext, body: Record<string, unknown>) => request.post('/test/request', { data: { sessionId: 'ses_fake_3', request: body } });
    const openEmpty = async (page: Page, request: APIRequestContext) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_3');
      await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
    };
    const settle = (page: Page) => page.waitForTimeout(450); // the collapse and the fade end (300 ms)
    const BRANCH = {
      id: 'branch',
      header: '',
      question: 'Which branch should I push to?',
      options: [
        { label: 'fix-parser', description: 'The branch with the fix' },
        { label: 'main', description: 'Straight to the default branch' },
      ],
      isOther: true,
      isSecret: false,
    };

    test('card-approval-command, card-approval-more, card-approval-answered', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_2'); // seeded waiting for its command approval
      const card = page.getByRole('group', { name: 'Approval: Run this command?' });
      await expect(card).toBeVisible();
      await shot(page, 'card-approval-command');
      await card.getByRole('button', { name: 'More' }).click();
      await expect(card.getByRole('group', { name: 'More choices' })).toBeVisible();
      await settle(page);
      await shot(page, 'card-approval-more');
      await card.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(page.getByLabel('Approval answered')).toContainText('Approved');
      await expect(page.getByLabel('Session status')).toHaveText('Finished');
      await settle(page);
      await shot(page, 'card-approval-answered');
    });

    test('card-approval-files', async ({ page, request }) => {
      await openEmpty(page, request);
      await addRequest(request, { kind: 'fileChange', reason: 'Write the README and a note.', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], changes: CHANGES });
      await expect(page.getByRole('group', { name: 'Approval: Change 3 files?' })).toBeVisible();
      await shot(page, 'card-approval-files');
    });

    test('card-question-single, card-question-answered', async ({ page, request }) => {
      await openEmpty(page, request);
      await addRequest(request, { kind: 'input', isBlocking: false, questions: [BRANCH] });
      const card = page.getByRole('group', { name: 'Question: Which branch should I push to?' });
      await card.getByText('fix-parser', { exact: true }).click();
      await shot(page, 'card-question-single');
      await card.getByRole('button', { name: 'Send answer' }).click();
      await expect(page.getByLabel('Question answered')).toContainText('fix-parser');
      await settle(page);
      await shot(page, 'card-question-answered');
    });

    test('card-question-multi-other', async ({ page, request }) => {
      await openEmpty(page, request);
      await addRequest(request, {
        kind: 'input',
        isBlocking: false,
        questions: [
          {
            id: 'sections',
            header: 'Sections',
            question: 'Which sections should the README have?',
            options: [
              { label: 'Install', description: 'How to install.' },
              { label: 'Usage', description: 'How to use it.' },
            ],
            multiSelect: true,
            isOther: true,
            isSecret: false,
          },
        ],
      });
      const card = page.getByRole('group', { name: 'Question: Which sections should the README have?' });
      await card.getByText('Install', { exact: true }).click();
      await card.getByText('Other…', { exact: true }).click();
      await card.getByRole('textbox', { name: 'Other answer to Sections' }).fill('FAQ');
      await page.getByRole('textbox', { name: 'Other answer to Sections' }).blur();
      await shot(page, 'card-question-multi-other');
    });

    test('card-pinned-question', async ({ page, request }) => {
      await openEmpty(page, request);
      await addRequest(request, { kind: 'input', isBlocking: true, questions: [{ ...BRANCH, isOther: false }] });
      await expect(page.getByRole('region', { name: 'Waiting for your answer' })).toBeVisible();
      await shot(page, 'card-pinned-question');
    });

    test('card-bypass-header', async ({ page, request }) => {
      await pair(page, request);
      await page.getByRole('button', { name: 'New session' }).click();
      const sheet = page.getByRole('dialog', { name: 'New session' });
      await sheetsSettled(page);
      await sheet.getByRole('switch', { name: 'Bypass approvals (full access)' }).click();
      await sheet.getByLabel('Title (optional)').fill('Full access session');
      await sheet.getByRole('button', { name: 'Start session' }).click();
      await expect(page.locator('.nav-extra')).toHaveText(' · Full access');
      await shot(page, 'card-bypass-header');
    });

    test('changes', async ({ page, request }) => {
      await pair(page, request);
      await page.goto('/s/ses_fake_3');
      await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
      await request.post('/test/review', { data: { sessionId: 'ses_fake_3', chunks: ['ok\n'] } });
      const conversation = page.getByRole('region', { name: 'Conversation' });
      await expect(conversation.locator('[data-item="command"]')).toContainText('npm test');
      await request.post('/test/review-finish', { data: { sessionId: 'ses_fake_3', changes: CHANGES } });
      await expect(conversation.locator('[data-item="fileChange"]')).toContainText('src/new.ts');
      await shot(page, 'session-finished');
      await conversation.locator('[data-item="fileChange"]').click();
      const sheet = page.getByRole('dialog', { name: 'File change' });
      await expect(sheet).toContainText('3 files changed');
      await shot(page, 'changes');
      await sheet.getByRole('button', { name: /src\/app\.ts/ }).click();
      await expect(sheet.getByRole('region', { name: 'Diff of src/app.ts' })).toBeVisible();
      await shot(page, 'changes-diff');
    });

  });
}
