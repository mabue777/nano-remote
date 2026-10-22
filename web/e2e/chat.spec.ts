import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Local chat at 390 x 844 against the fake provider (test/fake-provider.ts): an OpenAI-compatible cloud
// API that streams SSE and Ollama (the ollama.com preset's host) that streams NDJSON, both reached directly
// over https; plus a LAN Ollama that runs through the Mac (ADR 0006). Providers and chats are seeded into
// localStorage the way the stores keep them, since the provider settings screen is its own ticket.
//
// UPDATE_SCREENSHOTS=1 also writes the chat view's screenshot to e2e/screenshots/ (kept in git).

const PROVIDER_PORT = 4174;
const CLOUD = {
  id: 'prv_cloud',
  name: 'Fake Cloud',
  baseURL: `https://api.fake-provider.test:${PROVIDER_PORT}/v1`,
  kind: 'openai-compatible',
  apiKeyFingerprint: 'sk-fak',
  models: {
    list: [
      { id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' },
      { id: 'fake-mini', displayName: 'fake-mini', capabilities: { tools: false, reasoning: false }, source: 'vendor' },
    ],
    lastProbedAt: 1,
  },
  hiddenModels: [],
  pinnedModels: [],
  supportsTools: 'unknown',
  refresh: { mode: 'manual' },
};
const OLLAMA_CLOUD = { ...CLOUD, id: 'prv_ollama', name: 'Ollama Cloud', baseURL: `https://ollama.com:${PROVIDER_PORT}`, kind: 'ollama', models: { list: [], lastProbedAt: null } };
const MAC_OLLAMA = {
  ...CLOUD,
  id: 'prv_mac',
  name: 'Mac Ollama',
  baseURL: 'http://192.168.1.50:11434',
  kind: 'ollama',
  apiKeyFingerprint: null,
  models: { list: [{ id: 'llama3.2:1b', displayName: 'llama3.2:1b', capabilities: {}, source: 'unknown' }], lastProbedAt: 1 },
};

type SeedProvider = typeof CLOUD | typeof OLLAMA_CLOUD | typeof MAC_OLLAMA;

async function seed(page: Page, providers: SeedProvider[], chats: unknown[] = []): Promise<void> {
  await page.goto('/pair');
  await page.evaluate(
    ({ providers, chats }) => {
      localStorage.clear();
      localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers, defaultProviderId: providers[0]?.id ?? null }));
      const keys = Object.fromEntries(providers.filter((p) => p.baseURL.startsWith('https:')).map((p) => [p.id, 'sk-fake-key']));
      localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys }));
      localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats }));
    },
    { providers, chats },
  );
}

function chat(id: string, title: string, minutesAgo: number) {
  const at = Date.now() - minutesAgo * 60_000;
  return { id, title, providerId: CLOUD.id, model: 'fake-reasoner', createdAt: at, updatedAt: at, messages: [{ role: 'user', text: title, status: 'complete' }] };
}

async function longPress(target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 0, pointerType: 'touch', isPrimary: true };
  await target.dispatchEvent('pointerdown', at);
  await target.page().waitForTimeout(650);
  await target.dispatchEvent('pointerup', at);
}

async function swipeLeft(target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const y = box.y + box.height / 2;
  const base = { button: 0, pointerType: 'touch', isPrimary: true, clientY: y };
  await target.dispatchEvent('pointerdown', { ...base, clientX: box.x + box.width - 20 });
  await target.dispatchEvent('pointermove', { ...base, clientX: box.x + box.width - 60 });
  await target.dispatchEvent('pointermove', { ...base, clientX: box.x + box.width - 120 });
  await target.dispatchEvent('pointerup', { ...base, clientX: box.x + box.width - 120 });
}

async function providerChats(request: APIRequestContext): Promise<Record<string, unknown>[]> {
  return ((await (await request.post('/test/provider-chats')).json()) as { chats: Record<string, unknown>[] }).chats;
}

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

test('unpaired with a provider: Chats is home, a new chat streams a reply in under 2 s, reasoning folds', async ({ page, request }) => {
  await seed(page, [CLOUD]);
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/); // not sent to pairing
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pair your Mac' })).toBeVisible();
  await expect(page.getByText('No chats yet. Start one with New chat.')).toBeVisible();

  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page).toHaveURL(/\/c\/[\w-]+$/);
  await expect(page.getByRole('button', { name: 'Model: Fake Reasoner' })).toBeVisible();
  await expect(page.getByLabel('Provider')).toHaveText('Fake Cloud · direct');
  const thinking = page.getByRole('switch', { name: 'Thinking' });
  await expect(thinking).toHaveAttribute('aria-checked', 'true');

  await page.getByLabel('Message').fill('Say hi in three words.');
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('.chat-message.assistant');
  await expect(reply.locator('.msg.agent')).toContainText('Hey', { timeout: 2000 });
  expect(Date.now() - sent).toBeLessThan(2000);
  await expect(reply.locator('.msg.agent')).toHaveText('Hey there, friend!');
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible(); // the stream ended
  await expect(reply.getByLabel('Token usage')).toHaveText('73 in · 24 out tokens');

  // The reasoning block folded once the answer started; a tap opens and closes it.
  const toggle = reply.getByRole('button', { name: /Thinking/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(reply.locator('.reasoning-text')).toContainText('We need to respond with three-word greeting.');
  await page.screenshot({ path: test.info().outputPath('chat-view-390.png') });
  if (process.env.UPDATE_SCREENSHOTS === '1') await page.screenshot({ path: 'e2e/screenshots/chat-view-390.png' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(reply.locator('.reasoning-text')).toHaveCount(0);

  const [body] = await providerChats(request);
  expect(body).toMatchObject({ model: 'fake-reasoner', stream: true, messages: [{ role: 'user', content: 'Say hi in three words.' }] });

  // Back on Chats: the row shows title, model, provider and time.
  await page.getByRole('link', { name: '‹ Chats' }).click();
  const row = page.getByRole('list', { name: 'Chats' }).getByRole('link');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Say hi in three words.');
  await expect(row).toContainText('Fake Reasoner · Fake Cloud · just now');
});

test('Stop keeps the partial text, also after a reload', async ({ page }) => {
  await seed(page, [CLOUD]);
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Message').fill('Count slowly, please.');
  await page.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('.chat-message.assistant');
  await expect(reply.locator('.msg.agent')).toHaveText('Hey');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(reply).toContainText('Stopped');
  await expect(reply.locator('.msg.agent')).toHaveText('Hey');
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.chat-message.assistant .msg.agent')).toHaveText('Hey');
  await expect(page.locator('.chat-message.assistant')).toContainText('Stopped');
});

test('the model picker refreshes Ollama and its NDJSON reply streams', async ({ page, request }) => {
  await seed(page, [CLOUD, OLLAMA_CLOUD]);
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('button', { name: 'Model: Fake Reasoner' }).click();
  const picker = page.getByRole('dialog', { name: 'Model' });
  const ollama = picker.getByRole('region', { name: 'Ollama Cloud' });
  await expect(ollama).toContainText('No models cached. Refresh to load them.');
  await ollama.getByRole('button', { name: 'Refresh models of Ollama Cloud' }).click();
  await ollama.getByRole('button', { name: 'llama-fake:1b' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Model: llama-fake:1b' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Thinking' })).toHaveCount(0); // no reasoning capability known

  await page.getByLabel('Message').fill('Say hi in three words.');
  await page.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('.chat-message.assistant');
  await expect(reply.locator('.msg.agent')).toHaveText('Hi there friend', { timeout: 5000 });
  await expect(reply.getByRole('button', { name: /Thinking/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(reply.getByLabel('Token usage')).toHaveText('73 in · 88 out tokens');
  const chats = await providerChats(request);
  expect(chats.at(-1)).toMatchObject({ model: 'llama-fake:1b', stream: true });
});

test('delete a chat by long-press and by swipe', async ({ page }) => {
  await seed(page, [CLOUD], [chat('chat_a', 'First question', 30), chat('chat_b', 'Second question', 5)]);
  await page.goto('/');
  const list = page.getByRole('list', { name: 'Chats' });
  await expect(list.getByRole('link')).toHaveText([/Second question/, /First question/]);

  await longPress(list.getByRole('link', { name: /First question/ }));
  await page.getByRole('button', { name: 'Delete First question' }).click();
  await expect(list.getByRole('link')).toHaveText([/Second question/]);

  await swipeLeft(list.getByRole('link', { name: /Second question/ }));
  await page.getByRole('button', { name: 'Delete Second question' }).click();
  await expect(page.getByText('No chats yet. Start one with New chat.')).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nano-remote/chats/v1')!).chats.length);
  expect(stored).toBe(0);
});

test('a provider that runs through the Mac says the Mac is not reachable', async ({ page }) => {
  await seed(page, [MAC_OLLAMA]);
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByLabel('Provider')).toHaveText('Mac Ollama · via your Mac');
  await page.getByLabel('Message').fill('Hello?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.chat-message.assistant').getByRole('alert')).toHaveText('Your Mac is not reachable; this provider runs through it.');
});

test('paired: Sessions stays the default, the switch opens Chats with the no-providers link', async ({ page, request }) => {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  const tabs = page.getByRole('tablist', { name: 'Home' });
  await expect(tabs.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Chats' }).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByText('Add a model provider to start chatting.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings › Providers' })).toHaveAttribute('href', '/settings/providers');
  await expect(page.getByRole('button', { name: 'New chat' })).toBeDisabled();
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page).toHaveURL(/\/$/);
});
