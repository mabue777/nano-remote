import { mkdirSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { closeDetails, openDetails, sheetsSettled } from './sheets';

// Changing an open session's approval mode at 390 x 844 (spec 6 session/settings/update approvalMode): the
// Permissions row of the ⋯ details sheet opens a sheet with the agent's modes in plain words; full access
// asks first; the header's " · Full access" and the row follow the session the host answers with. Claude
// Code and Pi take the change at once, Codex from its next turn ("Applies from the next turn"). A Pi
// session can also start in Accept edits from the New session sheet. The fake host runs a command that asks for approval in every turn unless the turn
// runs in full access. Screenshots, light and dark, go to /tmp/perm-switch-shots/ for the operator.
const SHOTS = '/tmp/perm-switch-shots';
const PI_SHOTS = '/tmp/pi-perms-shots';

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

/** Starts a session of the agent from the New session sheet, without a first message. */
async function startSession(page: Page, agent: string): Promise<void> {
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('radio', { name: agent }).click();
  await sheet.getByLabel('Title (optional)').fill(`${agent} permissions`);
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page);
}

const card = (page: Page) => page.getByRole('group', { name: 'Approval: Run this command?' });
const footnote = (page: Page) => page.locator('.nav-footnote');

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** A turn that asks: the card comes, Accept answers it, the turn finishes. */
async function acceptApproval(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
}

/** The ⋯ sheet's Permissions row opens the Permissions sheet. */
async function openPermissions(page: Page): Promise<Locator> {
  const details = await openDetails(page);
  await details.getByTitle('Change permissions').click();
  const sheet = page.getByRole('dialog', { name: 'Permissions' });
  await expect(sheet).toBeVisible();
  await sheetsSettled(page);
  return sheet;
}

async function closeSheet(page: Page, sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page);
}

async function shootTo(page: Page, target: Locator | Page, dir: string, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await target.screenshot({ path: `${dir}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const shoot = (page: Page, target: Locator | Page, name: string): Promise<void> => shootTo(page, target, SHOTS, name);

test('Claude Code: switch to full access at once (after a confirmation), then back to asking', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  await pair(page, request);
  await startSession(page, 'Claude Code');
  await send(page, 'first');
  await acceptApproval(page);
  await expect(footnote(page)).not.toContainText('Full access');

  let sheet = await openPermissions(page);
  const modes = sheet.getByRole('radio');
  await expect(modes).toHaveCount(4);
  await expect(sheet.locator('.permission-title')).toHaveText(['Ask before running', 'Accept edits', 'Plan only', 'Bypass approvals (full access)']);
  await expect(sheet.getByRole('radio', { name: /^Ask before running/ })).toHaveAttribute('aria-checked', 'true');
  await shoot(page, page, 'claude-sheet');

  // Full access asks first, in the New session sheet's words.
  await sheet.getByRole('radio', { name: /^Bypass approvals \(full access\)/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Bypass approvals?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('The agent runs every command and edit without asking, anywhere your user account can reach.');
  await sheetsSettled(page);
  await shoot(page, page, 'claude-confirm');
  expect(await lastParams(request, 'session/settings/update')).toBeNull();
  await confirm.getByRole('button', { name: 'Allow full access' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(sheet.getByRole('radio', { name: /^Bypass approvals/ })).toHaveAttribute('aria-checked', 'true');
  expect(await lastParams(request, 'session/settings/update')).toEqual({ sessionId: new URL(page.url()).pathname.split('/').at(-1), settings: { approvalMode: 'never' } });
  // Claude Code took it at once: no footnote.
  await expect(sheet.getByRole('note')).toHaveCount(0);
  await sheetsSettled(page);
  await shoot(page, page, 'claude-full-access');
  await closeSheet(page, sheet);
  await expect(footnote(page)).toHaveText(/ · Full access$/);
  let details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toHaveText(/Permissions\s*Full access/);
  await closeDetails(page, details);

  // The next command runs without asking.
  await send(page, 'second');
  await expect(footnote(page)).toHaveText(/^Finished · Full access$/);
  await expect(card(page)).toHaveCount(0);

  // Back to asking: one tap, no confirmation, and the next command asks again.
  sheet = await openPermissions(page);
  await sheet.getByRole('radio', { name: /^Ask before running/ }).click();
  await expect(sheet.getByRole('radio', { name: /^Ask before running/ })).toHaveAttribute('aria-checked', 'true');
  await closeSheet(page, sheet);
  await expect(footnote(page)).not.toContainText('Full access');
  details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toHaveText(/Permissions\s*Asks before running/);
  await closeDetails(page, details);
  await send(page, 'third');
  await acceptApproval(page);
});

test('Codex: a change during a turn applies from the next turn and says so', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  await pair(page, request);
  await startSession(page, 'Codex');
  await send(page, 'first');
  await expect(card(page)).toBeVisible();

  // While the turn waits for its approval, switch to full access.
  const sheet = await openPermissions(page);
  await expect(sheet.locator('.permission-title')).toHaveText([
    'Ask for most commands',
    'Ask when a command fails',
    'Ask when it needs more access',
    'Bypass approvals (full access)',
  ]);
  await expect(sheet.getByRole('radio', { name: /^Ask when it needs more access/ })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('radio', { name: /^Bypass approvals/ }).click();
  await page.getByRole('dialog', { name: 'Bypass approvals?' }).getByRole('button', { name: 'Allow full access' }).click();
  await expect(sheet.getByRole('note')).toHaveText('Applies from the next turn');
  await sheetsSettled(page);
  await shoot(page, page, 'codex-next-turn');
  await closeSheet(page, sheet);
  await expect(footnote(page)).toHaveText(/ · Full access$/);

  // The running turn keeps its approval; the next turn runs without asking.
  await acceptApproval(page);
  await send(page, 'second');
  await expect(footnote(page)).toHaveText(/^Finished · Full access$/);
  await expect(card(page)).toHaveCount(0);
});

test('Pi: start with Accept edits; switch to full access mid-turn, and the next command runs without asking', async ({ page, request }) => {
  mkdirSync(PI_SHOTS, { recursive: true });
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const start = page.getByRole('dialog', { name: 'New session' });
  await start.getByRole('radio', { name: 'Pi' }).click();
  await start.getByRole('switch', { name: 'Accept edits' }).click();
  await expect(start.getByRole('note')).toHaveText('Edits files in the folder without asking; still asks before running commands.');
  await sheetsSettled(page);
  await shootTo(page, start, PI_SHOTS, 'pi-new-session-accept-edits');
  await start.getByLabel('Title (optional)').fill('Pi permissions');
  await start.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page);
  expect(await lastParams(request, 'session/start')).toMatchObject({ agentId: 'pi', settings: { approvalMode: 'acceptEdits' } });

  let details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toHaveText(/Permissions\s*Accepts edits/);
  await closeDetails(page, details);

  // A command still asks in Accept edits; while it waits, switch to full access.
  await send(page, 'first');
  await expect(card(page)).toBeVisible();
  const sheet = await openPermissions(page);
  await expect(sheet.locator('.permission-title')).toHaveText(['Ask before running', 'Accept edits', 'Bypass approvals (full access)']);
  await expect(sheet.getByRole('radio', { name: /^Accept edits/ })).toHaveAttribute('aria-checked', 'true');
  await shootTo(page, page, PI_SHOTS, 'pi-permissions-sheet');
  await sheet.getByRole('radio', { name: /^Bypass approvals/ }).click();
  await page.getByRole('dialog', { name: 'Bypass approvals?' }).getByRole('button', { name: 'Allow full access' }).click();
  await expect(sheet.getByRole('radio', { name: /^Bypass approvals/ })).toHaveAttribute('aria-checked', 'true');
  // pi takes it at once: no "Applies from the next turn".
  await expect(sheet.getByRole('note')).toHaveCount(0);
  await sheetsSettled(page);
  await shootTo(page, page, PI_SHOTS, 'pi-full-access');
  await closeSheet(page, sheet);
  await expect(footnote(page)).toHaveText(/ · Full access$/);
  details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toHaveText(/Permissions\s*Full access/);
  await closeDetails(page, details);

  // The request already waiting stays; after it, the next command runs without asking.
  await acceptApproval(page);
  await send(page, 'second');
  // The second turn's command ran (two finished commands, one answered card) without a new card.
  await expect(page.getByText('Done. Created hello.txt in the current directory.')).toHaveCount(2);
  await expect(footnote(page)).toHaveText(/^Finished · Full access$/);
  await expect(card(page)).toHaveCount(0);
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ decision: 'accept' });
  await shootTo(page, page, PI_SHOTS, 'pi-session-full-access');
});
