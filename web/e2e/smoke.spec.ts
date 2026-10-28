import { expect, test, type APIRequestContext, type Page } from './worker-host';

// Phone smoke against the fake host (test/e2e-server.ts): pair with a code from the link, land on home,
// see the host, the agents and the scripted sessions (the third only through cursor paging), and start
// a new session. Wrong, expired and reused codes show the error and a retry works.

const TITLES = ['Create hello.txt and list files', 'Run the test suite', 'Sketch the README'];

// Every test starts from the three seeded sessions (other specs run turns in them).
test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function freshCode(request: APIRequestContext, kind: 'code' | 'expire' = 'code'): Promise<string> {
  const response = await request.post(`/test/${kind}`);
  return ((await response.json()) as { code: string }).code;
}

async function pair(page: Page, code: string): Promise<void> {
  await page.goto(`/pair#code=${code}`);
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair' }).click();
}

test('pair with a code, land on home, see host, agents and the scripted sessions', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/pair$/); // not paired yet: home sends us to pairing

  await pair(page, await freshCode(request));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');

  // Home is the flat list (look step 6): the host card lives in Settings.
  await expect(page.getByRole('region', { name: 'Host' })).toHaveCount(0);
  const sessions = page.getByRole('list', { name: 'Sessions' });
  await expect(sessions.getByRole('link')).toHaveCount(3); // page two arrives by cursor (infinite scroll)
  await expect(sessions.getByRole('link')).toHaveText([new RegExp(TITLES[1]!), new RegExp(TITLES[0]!), new RegExp(TITLES[2]!)]);
  const waiting = sessions.getByRole('link', { name: new RegExp(TITLES[1]!) });
  await expect(waiting).toContainText('Needs approval');
  await expect(waiting.locator('.row-sign')).toHaveAttribute('data-sign', 'needs'); // the one sign: the warn dot and word
  await expect(sessions.getByRole('link', { name: new RegExp(TITLES[0]!) })).toContainText('Finished');

  // Settings shows the host: name, uptime and agents.
  await page.getByRole('link', { name: 'Settings' }).click();
  const host = page.getByRole('region', { name: 'Host' });
  await expect(host.getByRole('heading', { name: 'mabue-mbp' })).toBeVisible();
  await expect(host).toContainText(/up \d+ d/); // uptime from host/status
  const agents = host.getByRole('list', { name: 'Agents' });
  // host/status (protocol example 44) replaces initialize's agents: Codex degraded, Claude ready.
  await expect(agents.getByRole('listitem')).toHaveText([/Codex.*adapter restarting/, /Claude Code.*ready/]);
  await page.locator('a.back').click();
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();

  // The app keeps no secret: the token is only in an HttpOnly cookie.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  const cookie = (await page.context().cookies()).find((c) => c.name === 'nano_device');
  expect(cookie?.httpOnly).toBe(true);
  expect(stored).not.toContain(cookie!.value);
  expect(await page.evaluate(() => document.cookie)).not.toContain('nano_device');

  // A reload renders home again from the same pairing.
  await page.reload();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');

  // Opening a session goes to /s/:sessionId and back.
  await sessions.getByRole('link', { name: new RegExp(TITLES[0]!) }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_1$/);
  await expect(page.getByRole('heading', { name: TITLES[0] })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
});

test('new session: agent, model, folder from browsing, title and first message', async ({ page, request }) => {
  await pair(page, await freshCode(request));
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('radio', { name: /Kimi/ })).toBeDisabled();
  await expect(sheet.getByLabel('Model')).toHaveValue('gpt-5.5-codex');
  await sheet.getByLabel('Model').selectOption('gpt-5.5-mini');
  await sheet.getByRole('button', { name: 'Browse' }).click();
  const browser = sheet.getByRole('group', { name: 'Folder browser' });
  await expect(browser.getByText('/Users/me/Desktop/phone-test', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: '..', exact: true }).click();
  await sheet.getByRole('button', { name: '..', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Desktop/' })).toBeVisible();
  await expect(sheet.getByText('notes.txt')).toHaveCount(0); // folders only
  await sheet.getByRole('button', { name: 'Desktop/' }).click();
  await sheet.getByRole('button', { name: 'Use this folder' }).click();
  await expect(sheet.locator('code.folder')).toHaveText('/Users/me/Desktop');
  await sheet.getByLabel('Title (optional)').fill('Phone smoke session');
  await sheet.getByLabel('First message (optional)').fill('Create hello.txt');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await expect(page.getByRole('heading', { name: 'Phone smoke session' })).toBeVisible();
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Phone smoke session/ })).toBeVisible();
});

test('wrong, expired and reused codes show the error; a retry with a fresh code pairs', async ({ page, request, browser }) => {
  await pair(page, '00000000');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('wrong, expired');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeDisabled(); // the spent code was cleared

  await page.getByLabel('Pairing code').fill(await freshCode(request, 'expire'));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(alert).toContainText('expired');

  const code = await freshCode(request);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await pair(otherPage, code); // another phone uses it first
  await expect(otherPage).toHaveURL(/\/$/);
  await other.close();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(alert).toContainText('already used');

  await page.getByLabel('Pairing code').fill(await freshCode(request));
  await page.getByLabel('Device name').fill('Test phone');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
});

test('a stored device whose cookie the host does not know goes back to pairing', async ({ page }) => {
  await page.goto('/pair');
  await page.evaluate(() => localStorage.setItem('nano-remote.device.v1', JSON.stringify({ clientId: 'dev_ghost', hostName: 'x' })));
  await page.goto('/');
  await expect(page).toHaveURL(/\/pair$/); // closed 4003: unpaired
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
});
