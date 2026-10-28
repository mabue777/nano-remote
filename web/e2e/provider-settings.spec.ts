import { readFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page } from './worker-host';

// Settings > Providers at 390 x 844 (provider-connection.md sections 3 and 7). The fake provider
// (test/fake-provider.ts) answers as an OpenAI-compatible cloud API; the browser maps the OpenAI preset's
// host (api.openai.com) and api.fake-provider.test to it (playwright.config.ts), so the app calls it
// directly (ADR 0006). A models request with a key starting `sk-bad` gets 401. The fake host keeps one
// provider in its "config.json" (provider/list) and its scan finds an Ollama on 127.0.0.1:11434.

const PROVIDER_PORT = 4174;
const UNREACHABLE_PORT = 4199; // nothing listens here

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function freshPage(page: Page, storage: Record<string, unknown> = {}): Promise<void> {
  await page.goto('/pair');
  await page.evaluate((items) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, JSON.stringify(value));
  }, storage);
}

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

const providerRow = (page: Page, name: string) => page.getByRole('list', { name: 'Providers' }).getByRole('listitem', { name, exact: true });

test('add by pasting a key: OpenAI is detected, no URL typed, and its model list shows in under 20 s', async ({ page }) => {
  await freshPage(page);
  const started = Date.now();
  await page.goto('/settings/providers'); // the old address; no host needed for a cloud provider
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByText('No providers yet. Add one to start chatting.')).toBeVisible();

  await page.getByRole('button', { name: 'Add provider' }).click();
  await page.getByLabel('Paste an API key or a server URL').fill('sk-proj-e2e-0123456789');
  await expect(page.getByText('OpenAI key · direct')).toBeVisible();
  await expect(page.getByRole('button', { name: 'OpenAI', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Base URL')).toHaveValue('https://api.openai.com/v1');
  const add = page.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled(); // test before add

  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const result = page.locator('.test-result');
  await expect(result).toHaveAttribute('data-status', 'ok');
  await expect(result.getByRole('status')).toHaveText('Connected · 2 models');
  await expect(result.getByRole('list', { name: 'Models' }).getByRole('listitem')).toHaveText(['Fake Reasoner', 'fake-mini']);
  expect(Date.now() - started).toBeLessThan(20_000);
  await page.screenshot({ path: test.info().outputPath('provider-add-390.png') });
  if (process.env.UPDATE_SCREENSHOTS === '1') await page.screenshot({ path: 'e2e/screenshots/provider-add-390.png' });

  await add.click();
  await expect(page.getByRole('status')).toContainText('Added OpenAI.');
  const row = providerRow(page, 'OpenAI');
  await expect(row).toContainText('Default');
  await expect(row).toContainText('OpenAI-compatible');
  await expect(row).toContainText('https://api.openai.com/v1');
  await expect(row.locator('.provider-meta')).toHaveText(/^direct · key sk-pro… · 2 models · probed just now$/);
  const keys = await page.evaluate(() => JSON.parse(localStorage.getItem('nano-remote/provider-keys/v1')!).keys);
  expect(Object.values(keys)).toEqual(['sk-proj-e2e-0123456789']);

  // Without a paired Mac, "Find local servers" says so in one line.
  await page.getByRole('button', { name: 'Find local servers' }).click();
  await expect(page.getByText('Pair your Mac first: it is the one that looks for servers on your network.')).toBeVisible();

  // Back on Chats, the new provider is the default for a new chat.
  await page.getByRole('link', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByLabel('Provider')).toHaveText('OpenAI · direct');
});

test('add by URL: a wrong key gives the 401 sentence, an unreachable host the connect sentence within 10 s', async ({ page }) => {
  await freshPage(page);
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: 'Add provider' }).click();
  const paste = page.getByLabel('Paste an API key or a server URL');
  await paste.fill(`https://api.fake-provider.test:${PROVIDER_PORT}/v1`);
  await expect(page.getByText('Server URL · OpenAI-compatible · direct')).toBeVisible();
  await page.getByLabel('API key', { exact: true }).fill('sk-bad-key');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const alert = page.locator('.test-result').getByRole('alert');
  await expect(alert).toHaveText(`api.fake-provider.test:${PROVIDER_PORT} rejected the key. Check that you pasted the whole key.`);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add without testing' })).toBeVisible();

  // The right key: the list loads and Add enables.
  await page.getByLabel('API key', { exact: true }).fill('sk-good-key');
  await expect(alert).toHaveCount(0); // a change makes the last test stale
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.locator('.test-result')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

  await paste.fill(`https://api.fake-provider.test:${UNREACHABLE_PORT}/v1`);
  const tested = Date.now();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(alert).toHaveText(
    `api.fake-provider.test:${UNREACHABLE_PORT} did not answer within 10 seconds. Check the address and that the server is running.`,
    { timeout: 10_000 },
  );
  expect(Date.now() - tested).toBeLessThan(10_000);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

  // An offline server may still be added on purpose.
  await page.getByRole('button', { name: 'Add without testing' }).click();
  await expect(providerRow(page, `api.fake-provider.test:${UNREACHABLE_PORT}`).locator('.provider-meta')).toHaveText('direct · no key · no models yet · never probed');
});

test('paired: the gear opens Settings, the Mac-kept provider is read-only, and the scan adds Ollama with one tap', async ({ page, request }) => {
  await pair(page, request); // a fresh browser context: nothing stored yet
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  const studio = providerRow(page, 'Studio vLLM');
  await expect(studio).toHaveAttribute('data-source', 'mac');
  await expect(studio.locator('.provider-meta')).toHaveText('via your Mac · key on your Mac · 1 model');
  await expect(studio.getByRole('button')).toHaveCount(0); // read-only here
  await expect(studio).toContainText("Kept on your Mac: edit it in the Mac's config.json.");

  await page.getByRole('button', { name: 'Find local servers' }).click();
  const found = page.getByRole('list', { name: 'Servers found' });
  const ollama = found.getByRole('button', { name: /Ollama on your Mac/ });
  await expect(ollama).toContainText('Ollama · http://127.0.0.1:11434');
  await ollama.click();
  await expect(page.getByRole('status')).toContainText('Added Ollama on your Mac.');
  const row = providerRow(page, 'Ollama on your Mac');
  await expect(row).toContainText('Default');
  await expect(row.locator('.provider-meta')).toHaveText('via your Mac · no key · 2 models · probed just now');
  await expect(found.getByRole('button', { name: /Ollama on your Mac/ })).toBeDisabled();
  await expect(found).toContainText('Added');
  await page.screenshot({ path: test.info().outputPath('provider-list-390.png'), fullPage: true });
  const last = (await (await request.post('/test/last', { data: { method: 'provider/models' } })).json()) as { params: unknown };
  expect(last.params).toEqual({ baseURL: 'http://127.0.0.1:11434', kind: 'ollama' });
});

test('export, delete all, import: providers come back without keys and ask for them', async ({ page }) => {
  // No share sheet in this browser: Export downloads the file.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
  });
  const cloud = {
    id: 'prv_cloud',
    name: 'Fake Cloud',
    baseURL: `https://api.fake-provider.test:${PROVIDER_PORT}/v1`,
    kind: 'openai-compatible',
    apiKeyFingerprint: 'sk-sec',
    models: { list: [{ id: 'fake-mini', displayName: 'fake-mini', capabilities: {}, source: 'unknown' }], lastProbedAt: Date.now() },
    hiddenModels: [],
    pinnedModels: [],
    supportsTools: 'unknown',
    refresh: { mode: 'manual' },
  };
  const lan = { ...cloud, id: 'prv_lan', name: 'Mac Ollama', baseURL: 'http://192.168.1.50:11434', kind: 'ollama', apiKeyFingerprint: null };
  const at = Date.now();
  await freshPage(page, {
    'nano-remote/providers/v1': { v: 1, providers: [cloud, lan], defaultProviderId: cloud.id },
    'nano-remote/provider-keys/v1': { v: 1, keys: { prv_cloud: 'sk-secret-e2e' } },
    'nano-remote/chats/v1': { v: 1, chats: [{ id: 'chat_1', title: 'Hello', providerId: cloud.id, model: 'fake-mini', createdAt: at, updatedAt: at, messages: [] }] },
  });
  await page.goto('/settings/providers');
  await expect(providerRow(page, 'Fake Cloud')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()]);
  expect(download.suggestedFilename()).toBe('nano-remote-providers.json');
  const file = test.info().outputPath('providers.json');
  await download.saveAs(file);
  const text = await readFile(file, 'utf8');
  expect(text).not.toContain('sk-sec');
  const exported = JSON.parse(text) as { format: string; providers: { name: string }[] };
  expect(exported.format).toBe('nano-remote/providers');
  expect(exported.providers.map((p) => p.name)).toEqual(['Fake Cloud', 'Mac Ollama']);
  for (const p of exported.providers) expect(Object.keys(p)).not.toEqual(expect.arrayContaining(['apiKeyFingerprint']));

  await page.getByRole('button', { name: 'Delete all' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete every provider?' });
  await dialog.getByRole('button', { name: 'Delete all' }).click();
  await expect(page.getByText('No providers yet. Add one to start chatting.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('nano-remote/provider-keys/v1'))).not.toContain('sk-secret');

  // The chat's empty model picker leads back to Settings.
  await page.goto('/c/chat_1');
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('link', { name: 'Add one in Settings Providers' }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByLabel('Import file').setInputFiles(file);
  await expect(page.getByRole('status')).toContainText('Imported 2 providers. Enter the key where asked.');
  const imported = providerRow(page, 'Fake Cloud');
  await expect(imported.locator('.provider-meta')).toHaveText('direct · no key · no models yet · never probed');
  await expect(providerRow(page, 'Mac Ollama').getByLabel(/Enter the key/)).toHaveCount(0); // its key lives on the Mac
  await imported.getByLabel('Enter the key for Fake Cloud').fill('sk-new-e2e');
  await imported.getByRole('button', { name: 'Save key' }).click();
  await expect(imported.locator('.provider-meta')).toHaveText('direct · key sk-new… · 2 models · probed just now');
  await expect(imported.getByLabel('Enter the key for Fake Cloud')).toHaveCount(0);
});
