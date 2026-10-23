import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Pi on the new-session sheet at 390 x 844 (Phase 5b): the fake host lists agent "pi" with models from two
// providers (llamacpp, openrouter). The picker groups them by provider; choosing one starts the session on it
// (settings.model is the provider/model id); pi's approval card is the usual one with accept, decline and
// cancel; the session header and the session row name the model and its provider. Pi's capabilities honour
// no approvalMode (approvalModes []), so the sheet offers no "Bypass approvals" switch for it.

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

async function lastParams(request: APIRequestContext, method: string): Promise<Record<string, unknown> | null> {
  return ((await (await request.post('/test/last', { data: { method } })).json()) as { params: Record<string, unknown> | null }).params;
}

test('pick Pi and a model, start, accept the approval; header and row show the model and provider', async ({ page, request }) => {
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  const bypass = sheet.getByRole('switch', { name: 'Bypass approvals (full access)' });
  await expect(bypass).toBeVisible(); // Codex honours never

  await sheet.getByRole('radio', { name: 'Pi' }).click();
  await expect(sheet.getByRole('radio', { name: 'Pi' })).toHaveAttribute('aria-checked', 'true');
  await expect(bypass).toHaveCount(0);
  const picker = sheet.getByRole('combobox', { name: 'Model' });
  await expect(picker).toHaveValue('llamacpp/bonsai-27b'); // pi's default
  await expect(sheet.getByText('via llamacpp', { exact: true })).toBeVisible();
  // grouped by provider, each group in the host's order
  expect(await picker.locator('optgroup').evaluateAll((groups) => groups.map((g) => (g as HTMLOptGroupElement).label))).toEqual(['llamacpp', 'openrouter']);
  await expect(picker.locator('optgroup[label="openrouter"] option')).toHaveText(['DeepSeek V4.1 Flash', 'Qwen 3.5 Coder']);

  await picker.selectOption('openrouter/qwen/qwen3.5-coder');
  await expect(sheet.getByText('via openrouter', { exact: true })).toBeVisible();

  // The sheet stays within the 390 px viewport with Pi chosen.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  const pickerBox = (await picker.boundingBox())!;
  const sheetBox = (await sheet.boundingBox())!;
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
  await sheet.screenshot({ path: test.info().outputPath('new-session-pi-390.png') });

  await sheet.getByLabel('Title (optional)').fill('Pi phone session');
  await sheet.getByLabel('First message (optional)').fill('Create hello.txt');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  expect(await lastParams(request, 'session/start')).toMatchObject({ agentId: 'pi', settings: { model: 'openrouter/qwen/qwen3.5-coder' } });

  await expect(page.getByRole('heading', { name: 'Pi phone session' })).toBeVisible();
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('qwen/qwen3.5-coder · openrouter');

  const card = page.getByRole('group', { name: 'Approval: Run this command?' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button')).toHaveText(['Accept', 'Decline', 'Cancel']);
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ decision: 'accept' });
  await page.screenshot({ path: test.info().outputPath('pi-session-390.png') });

  await page.getByRole('link', { name: '‹ Sessions' }).click();
  const row = page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Pi phone session/ });
  await expect(row).toBeVisible();
  await expect(row.getByLabel('Model', { exact: true })).toHaveText('qwen/qwen3.5-coder · openrouter');
});
