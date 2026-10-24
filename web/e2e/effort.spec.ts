import { mkdirSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { sheetsSettled } from './sheets';

// The effort picker on the new-session sheet at 390 x 844 (spec 4 ModelInfo.efforts, 5.1 settings.effort):
// shown for a model with levels and its default preselected, hidden for a model without, "Auto" for a
// model without a default (Claude), the choice sent in session/start, remembered per agent, and named in
// the session header. Screenshots, light and dark, go to /tmp/effort/ for the operator.
const SHOTS = '/tmp/effort';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.5-codex');
  await sheetsSettled(page); // measured and photographed at rest
  return sheet;
}

async function lastParams(page: Page, method: string): Promise<Record<string, unknown> | null> {
  const answer = await page.request.post('/test/last', { data: { method } });
  return ((await answer.json()) as { params: Record<string, unknown> | null }).params;
}

test('effort: default preselected, sent, remembered per agent, hidden without levels, Auto for Claude', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');

  // Shown, with the model's default preselected.
  let sheet = await openSheet(page);
  const effort = sheet.getByRole('radiogroup', { name: 'Effort' });
  await expect(effort.getByRole('radio')).toHaveText(['Low', 'Medium', 'High', 'XHigh']);
  await expect(effort.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByText("Medium is this model's default.")).toBeVisible();
  // The segments stay inside the sheet on a 390 px phone.
  const group = (await effort.boundingBox())!;
  const frame = (await sheet.boundingBox())!;
  expect(group.x + group.width).toBeLessThanOrEqual(frame.x + frame.width);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await sheet.screenshot({ path: `${SHOTS}/new-session-effort-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // A choice goes in session/start and comes back in the header.
  await effort.getByRole('radio', { name: 'XHigh' }).click();
  await expect(effort.getByRole('radio', { name: 'XHigh' })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page); // the closed sheet's copy, with its own Effort group, has slid out
  expect((await lastParams(page, 'session/start'))?.settings).toEqual({ effort: 'xhigh' });
  await expect(page.getByLabel('Effort', { exact: true })).toHaveText('XHigh effort');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/session-header-effort-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();

  // Remembered for Codex on the next sheet.
  sheet = await openSheet(page);
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'XHigh' })).toHaveAttribute('aria-checked', 'true');

  // Hidden for a model without levels; nothing is sent.
  await sheet.getByRole('combobox', { name: 'Model' }).selectOption('gpt-5.5-mini');
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' })).toHaveCount(0);
  await expect(sheet.getByText('Effort', { exact: true })).toHaveCount(0);
  await sheet.screenshot({ path: `${SHOTS}/new-session-effort-hidden-light.png` });

  // Claude lists levels without a default: Auto is preselected and sends no effort.
  await sheet.getByRole('radio', { name: 'Claude Code' }).click();
  const claude = sheet.getByRole('radiogroup', { name: 'Effort' });
  await expect(claude.getByRole('radio')).toHaveText(['Auto', 'Low', 'Medium', 'High', 'XHigh', 'Max']);
  await expect(claude.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByText('Auto leaves the level to the agent.')).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await sheet.screenshot({ path: `${SHOTS}/new-session-effort-auto-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page);
  expect((await lastParams(page, 'session/start'))?.settings).toBeUndefined();
  await expect(page.getByLabel('Effort', { exact: true })).toHaveCount(0);
});
