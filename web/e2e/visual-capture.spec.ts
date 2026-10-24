import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { sheetsSettled } from './sheets';

// Reference screenshots of six screens at 390 x 844 against the fake host, for before/after pixel
// comparisons when styles change (the visual groundwork, and the redesign after it). Runs only when
// VISUAL_OUT names a folder: `VISUAL_OUT=/tmp/shots pnpm exec playwright test visual-capture`.
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

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
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
  await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

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

test('settings-providers', async ({ page, request }) => {
  await pair(page, request);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
  await expect(page.getByRole('switch')).toBeVisible(); // the host section (keep awake) has loaded
  await shot(page, 'settings-providers');
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
