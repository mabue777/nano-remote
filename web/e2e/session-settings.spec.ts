import { mkdirSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { sheetsSettled } from './sheets';

// Changing the model and effort of an open session at 390 x 844 (spec 6 session/settings/update): the
// header's model line opens a sheet with the New session sheet's grouped model picker and effort control;
// Save sends what changed and the header shows it; while a turn runs the sheet says "Applies after this
// turn" and the turn goes on; an agent without capabilities.settingsUpdate gets a plain line. Screenshots,
// light and dark, go to /tmp/session-settings/ for the operator.
const SHOTS = '/tmp/session-settings';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

/** The id of the session the page shows (/s/<id>). */
function shownSession(page: Page): string {
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

/**
 * Taps Save and checks the host received session/settings/update for the shown session with exactly
 * `settings`. Before the tap the host must have no such request since this test's reset, so a request
 * an earlier test sent can never stand in for this one.
 */
async function saveAndExpectSent(page: Page, request: APIRequestContext, sheet: Locator, settings: Record<string, string>): Promise<void> {
  expect(await lastParams(request, 'session/settings/update')).toBeNull();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page); // the copy sliding out still has its own Model and Effort labels
  await expect.poll(() => lastParams(request, 'session/settings/update')).toEqual({ sessionId: shownSession(page), settings });
}

async function lastParams(request: APIRequestContext, method: string): Promise<Record<string, unknown> | null> {
  return ((await (await request.post('/test/last', { data: { method } })).json()) as { params: Record<string, unknown> | null }).params;
}

/** Starts a session of the agent on a model from the New session sheet. */
async function startSession(page: Page, agent: string, model: string): Promise<void> {
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('radio', { name: agent }).click();
  await sheet.getByRole('combobox', { name: 'Model' }).selectOption(model);
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle('Change model and effort').click();
  const sheet = page.getByRole('dialog', { name: 'Model and effort' });
  await expect(sheet).toBeVisible();
  await sheetsSettled(page);
  return sheet;
}

async function shoot(page: Page, target: Locator | Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await target.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Codex: switch the model, then pick an effort the new model offers; the header follows', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  await pair(page, request);
  await startSession(page, 'Codex', 'gpt-5.5-mini');
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('gpt-5.5-mini');

  // The session's model is preselected; it has no levels, so there is no effort control and nothing to save.
  let sheet = await openSettings(page);
  const picker = sheet.getByRole('combobox', { name: 'Model' });
  await expect(picker).toHaveValue('gpt-5.5-mini');
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(sheet.getByRole('note')).toHaveCount(0);

  // The other model has levels: its default is preselected.
  await picker.selectOption('gpt-5.5-codex');
  const effort = sheet.getByRole('radiogroup', { name: 'Effort' });
  await expect(effort.getByRole('radio')).toHaveText(['Low', 'Medium', 'High', 'XHigh']);
  await expect(effort.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  await effort.getByRole('radio', { name: 'High', exact: true }).click();
  // Inside the 390 px viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const group = (await effort.boundingBox())!;
  const frame = (await sheet.boundingBox())!;
  expect(group.x + group.width).toBeLessThanOrEqual(frame.x + frame.width);
  await shoot(page, sheet, 'sheet-idle');

  await saveAndExpectSent(page, request, sheet, { model: 'gpt-5.5-codex', effort: 'high' });
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('gpt-5.5-codex');
  await expect(page.getByLabel('Effort', { exact: true })).toHaveText('High effort');
  await shoot(page, page.locator('.session-head'), 'header-after');

  // Reopened, the sheet starts from the new settings; Cancel sends nothing.
  sheet = await openSettings(page);
  await expect(sheet.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.5-codex');
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'High', exact: true })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page);
});

test('a running turn: the sheet says the change applies after it, and the turn goes on', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  await pair(page, request);
  // The seeded Claude session waits for an approval: its turn is running.
  await page.goto('/s/ses_fake_2');
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
  const sheet = await openSettings(page);
  await expect(sheet.getByRole('note')).toHaveText('Applies after this turn');
  // The seeded session names a model Claude no longer lists: it stays the current choice, without levels.
  const picker = sheet.getByRole('combobox', { name: 'Model' });
  await expect(picker).toHaveValue('gpt-5-codex');
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' })).toHaveCount(0);
  await picker.selectOption('claude-opus');
  const effort = sheet.getByRole('radiogroup', { name: 'Effort' });
  // The session names no level and Claude names no default: Auto is chosen.
  await expect(effort.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await effort.getByRole('radio', { name: 'Max' }).click();
  await shoot(page, sheet, 'sheet-running');
  await saveAndExpectSent(page, request, sheet, { model: 'claude-opus', effort: 'max' });
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('claude-opus');
  await expect(page.getByLabel('Effort', { exact: true })).toHaveText('Max effort');
  // The turn was not touched: the approval still waits.
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
  await expect(page.getByLabel('Session status')).toHaveAttribute('data-status', 'waiting_approval');
});

test('pi: the grouped picker; the header names the new model and its provider', async ({ page, request }) => {
  await pair(page, request);
  await startSession(page, 'Pi', 'llamacpp/bonsai-27b');
  const sheet = await openSettings(page);
  const picker = sheet.getByRole('combobox', { name: 'Model' });
  await expect(picker).toHaveValue('llamacpp/bonsai-27b');
  expect(await picker.locator('optgroup').evaluateAll((groups) => groups.map((g) => (g as HTMLOptGroupElement).label))).toEqual(['llamacpp', 'openrouter']);
  await picker.selectOption('openrouter/deepseek/deepseek-v4.1-flash');
  await expect(sheet.getByText('via openrouter', { exact: true })).toBeVisible();
  await saveAndExpectSent(page, request, sheet, { model: 'openrouter/deepseek/deepseek-v4.1-flash' });
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('deepseek/deepseek-v4.1-flash · openrouter');
});

test('an agent without the capability: the model line is plain text and opens nothing', async ({ page, request }) => {
  await request.post('/test/settings-locked', { data: { agentId: 'codex' } });
  await pair(page, request);
  await page.goto('/s/ses_fake_1');
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('gpt-5-codex');
  await expect(page.getByTitle('Change model and effort')).toHaveCount(0);
  await page.getByLabel('Model', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Model and effort' })).toHaveCount(0);
});

/**
 * Where the model line's first glyph sits (iPhone bug: "fable" showed as "rable", its first letter cut on the
 * left). The glyph starts inside the header's content box, aligned with the lines above; the button's clip
 * edge lies left of it with room for ink that starts left of the glyph's origin; nothing scrolled the name
 * sideways; and the strip at the left edge looks the same with the clip turned off, so no ink was cut.
 */
async function expectModelNameWhole(page: Page): Promise<void> {
  const button = page.getByTitle('Change model and effort');
  const geometry = await button.evaluate((el) => {
    const name = el.querySelector('[aria-label="Model"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(name, 0);
    range.setEnd(name, 1);
    const head = document.querySelector('.session-head')!;
    const pad = parseFloat(getComputedStyle(head).paddingLeft);
    return {
      glyph: range.getBoundingClientRect().x,
      contentLeft: head.getBoundingClientRect().x + pad,
      line: document.querySelector('.session-meta-line')!.getBoundingClientRect().x,
      clipLeft: el.getBoundingClientRect().x,
      height: el.getBoundingClientRect().height,
      scrollLeft: el.scrollLeft,
    };
  });
  expect(geometry.glyph).toBeGreaterThanOrEqual(geometry.contentLeft - 0.5);
  expect(geometry.glyph).toBeGreaterThanOrEqual(geometry.line - 0.5);
  expect(geometry.glyph - geometry.clipLeft).toBeGreaterThanOrEqual(1.5);
  expect(geometry.scrollLeft).toBe(0);
  expect(geometry.height).toBeGreaterThanOrEqual(32); // the tap target
  const box = (await button.boundingBox())!;
  const strip = { x: box.x - 4, y: box.y, width: 24, height: box.height };
  const clipped = await page.screenshot({ clip: strip });
  await button.evaluate((el) => (el.style.overflow = 'visible'));
  const unclipped = await page.screenshot({ clip: strip });
  await button.evaluate((el) => (el.style.overflow = ''));
  expect(clipped.equals(unclipped)).toBe(true);
}

test('the model line shows its first letter whole after the sheet opens and closes; a long name ellipsizes', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  await pair(page, request);
  await startSession(page, 'Claude', 'fable');
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('fable');
  await expectModelNameWhole(page);

  // Open, pick Medium, Save: the sheet closes and the header names both.
  let sheet = await openSettings(page);
  await sheet.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'Medium' }).click();
  await saveAndExpectSent(page, request, sheet, { effort: 'medium' });
  await expect(page.getByLabel('Effort', { exact: true })).toHaveText('Medium effort');
  await expectModelNameWhole(page);

  // Open and Cancel.
  sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page);
  await expectModelNameWhole(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.session-head').screenshot({ path: `${SHOTS}/header-model-name-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  // A name longer than the line stays inside it and ends in an ellipsis; its start is still whole.
  sheet = await openSettings(page);
  await sheet.getByRole('combobox', { name: 'Model' }).selectOption('claude-fable-experimental-preview-with-a-very-long-model-name');
  await sheet.getByRole('button', { name: 'Save' }).click(); // a second save: saveAndExpectSent checks only the first
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page);
  const button = page.getByTitle('Change model and effort');
  await expect(page.getByLabel('Model', { exact: true })).toHaveText('claude-fable-experimental-preview-with-a-very-long-model-name');
  const fit = await button.evaluate((el) => ({
    right: el.getBoundingClientRect().right,
    lineRight: el.parentElement!.getBoundingClientRect().right,
    truncated: el.scrollWidth > el.clientWidth,
    ellipsis: getComputedStyle(el).textOverflow,
  }));
  expect(fit.right).toBeLessThanOrEqual(fit.lineRight + 2.5); // the 2 px clip room
  expect(fit).toMatchObject({ truncated: true, ellipsis: 'ellipsis' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expectModelNameWhole(page);
  { const row = (await button.boundingBox())!; await page.screenshot({ path: `${SHOTS}/header-long-model.png`, clip: { x: 0, y: row.y - 60, width: 390, height: row.height + 60 } }); }
});
