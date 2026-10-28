import { mkdir } from 'node:fs/promises';

import { sheetsSettled } from './sheets';
import { expect, test, type APIRequestContext, type Page } from './worker-host';

// The review views against the fake host (test/e2e-server.ts): the item detail sheet opened from the turn
// list, with the output of a command (streamed, ANSI stripped, wrapped, followed, copyable) and the Changes
// view of the turn (the files with kind badges, then one file's diff with line numbers and colors, code
// unwrapped and scrolling sideways), the per-turn "N files changed" line, a folder outside git, and an agent
// that does not provide diffs. Screenshots of the Changes view go to /tmp/diff-view/.

const ESC = '\u001b';
const LONG = `${'very-long-path-segment/'.repeat(12)}end`;
/** 40 colored lines, one of them far wider than a phone. */
const CHUNKS = Array.from({ length: 40 }, (_, i) => `${ESC}[32m✓${ESC}[0m ${ESC}[1mtest ${i + 1}${ESC}[22m passed${i === 5 ? ` ${LONG}` : ''}\r\n`);
const PLAIN = Array.from({ length: 40 }, (_, i) => `✓ test ${i + 1} passed${i === 5 ? ` ${LONG}` : ''}\n`).join('');

const SHOTS = '/tmp/diff-view';

const CHANGES = [
  { path: 'src/new.ts', kind: 'add', diff: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n' },
  { path: 'src/app.ts', kind: 'modify', diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n import x from "x";\n-const a = 1;\n+const a = 2;\n export { a };\n' },
  { path: 'old.txt', kind: 'delete', diff: '--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' },
  { path: 'docs/guide.md', kind: 'modify', diff: 'diff --git a/guide.md b/docs/guide.md\nsimilarity index 95%\nrename from guide.md\nrename to docs/guide.md\n@@ -1 +1 @@\n-# Guide\n+# The guide\n' },
];

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

/** Unfolds the finished turn, opens its command's row, and its "Full output". */
async function openCommandSheet(page: Page): Promise<void> {
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await conversation.getByRole('button', { name: /previous message/ }).click();
  const command = conversation.locator('[data-item="command"]');
  await command.getByRole('button', { expanded: false }).click();
  await command.getByRole('button', { name: 'Full output' }).click();
}

async function openSession(page: Page, request: APIRequestContext, sessionId: string): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
}

test('the output view streams a running command as plain wrapped text, follows it, and copies it', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/review', { data: { sessionId: 'ses_fake_3', chunks: CHUNKS } });

  // The command's row opens its output under it; "Full output" opens the sheet.
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const command = conversation.locator('[data-item="command"]');
  await expect(command).toContainText('Running npm test');
  await command.getByRole('button', { name: 'Running npm test' }).click();
  await expect(command.locator('.row-output')).toContainText('test 1 passed');
  await command.getByRole('button', { name: 'Full output' }).click();

  const sheet = page.getByRole('dialog', { name: 'Command' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
  const output = sheet.getByLabel('Command output');
  await expect(output).toHaveAttribute('data-running', 'true');

  // While it runs the text grows, and the view keeps showing its end.
  await expect(output).toContainText('test 12 passed');
  await expect(output).not.toContainText('test 40 passed');
  const followed = async () =>
    output.evaluate((el) => ({ overflow: el.scrollHeight > el.clientHeight + 10, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight <= 24 }));
  await expect.poll(followed).toEqual({ overflow: true, atEnd: true });
  await expect(output).toContainText('test 30 passed');
  expect(await followed()).toEqual({ overflow: true, atEnd: true });
  await expect(output).toContainText('test 40 passed');

  // ANSI codes are gone, CRLF is plain lines, and the long line wraps instead of scrolling sideways.
  const text = await output.innerText();
  expect(text).not.toContain(ESC);
  expect(text).not.toContain('[32m');
  expect(text).not.toContain('\r');
  expect(text.trimEnd()).toBe(PLAIN.trimEnd());
  expect(await output.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await output.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Menlo|Consolas/i);

  // Copy puts the plain text on the clipboard.
  await sheet.getByRole('button', { name: 'Copy' }).click();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PLAIN);

  // The command ends; the sheet shows it done, and the turn's changes are one tab away.
  await request.post('/test/review-finish', { data: { sessionId: 'ses_fake_3', changes: CHANGES } });
  await expect(output).toHaveAttribute('data-running', 'false');
  await expect(sheet).toContainText('npm test · exit 0 · 1.5 s');
  await sheet.getByRole('tab', { name: 'Changes' }).click();
  await expect(sheet.getByRole('list', { name: 'Changed files' }).locator('li')).toHaveCount(4);

  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('the Changes view lists the files with kind words; a tapped file shows its diff with line numbers and colors', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/review', { data: { sessionId: 'ses_fake_3', chunks: ['ok\n'] } });
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('[data-item="command"]')).toContainText('npm test');
  await request.post('/test/review-finish', { data: { sessionId: 'ses_fake_3', changes: CHANGES } });

  // The finished turn folds its work; the file change row lists the files, and "Show changes" opens the
  // sheet on Changes.
  await conversation.getByRole('button', { name: '2 previous messages' }).click();
  const fileChange = conversation.locator('[data-item="fileChange"]');
  await expect(fileChange).toContainText('Edited 4 files');
  await fileChange.getByRole('button', { name: 'Edited 4 files' }).click();
  await expect(fileChange).toContainText('src/new.ts');
  // The file change row's own sheet: every file of the item from its own diff, one section each.
  await fileChange.getByRole('button', { name: 'Show changes' }).click();
  const own = page.getByRole('dialog', { name: 'File change' });
  await expect(own.locator('section.diff-file-view')).toHaveCount(4);
  await expect(own.getByRole('region', { name: 'Diff of src/app.ts' }).locator('[data-line="add"] .code')).toHaveText('const a = 2;');
  await own.getByRole('button', { name: 'Close' }).click();
  await expect(own).toHaveCount(0);

  // The turn's "4 files changed" line opens the list.
  await conversation.getByRole('button', { name: '4 files changed', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Changes' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.detail-subtitle')).toHaveText('4 files changed');
  const files = sheet.getByRole('list', { name: 'Changed files' }).locator(':scope > li > button');
  await expect(files).toHaveCount(4);
  await expect(files.nth(0)).toHaveAttribute('data-file-kind', 'added');
  await expect(files.nth(1)).toHaveAttribute('data-file-kind', 'modified');
  await expect(files.nth(2)).toHaveAttribute('data-file-kind', 'deleted');
  await expect(files.nth(3)).toHaveAttribute('data-file-kind', 'renamed');
  await expect(files.nth(0)).toContainText('Added');
  await expect(files.nth(0)).toContainText('+2 −0');
  await expect(files.nth(2)).toContainText('Deleted');
  await expect(files.nth(3)).toContainText('Renamed');
  await expect(files.nth(3)).toContainText('guide.md → docs/guide.md');

  // Tap a file: its diff replaces the list; "All files" goes back.
  await files.nth(1).click();
  const body = sheet.getByRole('region', { name: 'Diff of src/app.ts' });
  await expect(body).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'Changed files' })).toHaveCount(0);
  await expect(body.locator('[data-line="remove"] .code')).toHaveText('const a = 1;');
  await expect(body.locator('[data-line="add"] .code')).toHaveText('const a = 2;');
  await expect(body.locator('[data-line="context"]')).toHaveCount(2);
  // Old and new line numbers: the removed line was line 2, the added one is line 2, context 1 and 3.
  const numbers = await body.locator('tr').evaluateAll((rows) =>
    rows.map((row) => [row.getAttribute('data-line'), row.querySelector('.ln .old')!.textContent, row.querySelector('.ln .new')!.textContent]),
  );
  expect(numbers).toEqual([
    ['hunk', '', ''],
    ['context', '1', '1'],
    ['remove', '2', ''],
    ['add', '', '2'],
    ['context', '3', '3'],
  ]);
  const background = (kind: string) => body.locator(`[data-line="${kind}"] .code`).first().evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.backgroundImage} ${style.backgroundColor}`; // the --diff-* tint is a layer over --surface
    });
  const [added, removed, context] = [await background('add'), await background('remove'), await background('context')];
  expect(added).not.toBe(removed);
  expect(added).not.toBe(context);
  expect(removed).not.toBe(context);
  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await expect(body).toHaveCount(0);
  await expect(files).toHaveCount(4);
});

const LONG_LINE = `export const message = "${'a long line that does not fit on a phone '.repeat(6)}";`;
const HOST_DIFF = {
  files: [
    {
      path: 'src/server.ts',
      kind: 'modify',
      diff:
        'diff --git a/src/server.ts b/src/server.ts\nindex 3b18e51..a1f9c07 100644\n--- a/src/server.ts\n+++ b/src/server.ts\n' +
        '@@ -8,6 +8,7 @@ import { listen } from "./net";\n const port = 8080;\n-const host = "localhost";\n+const host = "0.0.0.0";\n+' +
        LONG_LINE +
        '\n \n export function start() {\n   return listen(host, port);\n }\n',
    },
    { path: 'README.md', kind: 'add', diff: 'diff --git a/README.md b/README.md\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1,2 @@\n+# Demo\n+Run it with npm start.\n' },
    { path: 'docs/setup.md', kind: 'rename', oldPath: 'setup.md', diff: 'diff --git a/setup.md b/docs/setup.md\nsimilarity index 100%\nrename from setup.md\nrename to docs/setup.md\n' },
    { path: 'old/legacy.js', kind: 'delete', diff: 'diff --git a/old/legacy.js b/old/legacy.js\ndeleted file mode 100644\nindex 6b4ad36..0000000\n--- a/old/legacy.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-var x = 1;\n-module.exports = x;\n' },
    { path: 'assets/logo.png', kind: 'modify', binary: true, diff: '' },
    { path: 'data/big.csv', kind: 'add', truncated: true, diff: 'diff --git a/data/big.csv b/data/big.csv\nnew file mode 100644\n--- /dev/null\n+++ b/data/big.csv\n@@ -0,0 +1,3 @@\n+id,name\n+1,one\n' },
  ],
  truncated: true,
};

test('a finished turn says "N files changed" and opens its Changes; long lines scroll sideways, never wrap', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await request.post('/test/turn-diff', { data: { sessionId: 'ses_fake_1', result: HOST_DIFF } });
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const line = conversation.getByRole('button', { name: '6 files changed', exact: true });
  await expect(line).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-session-files-changed.png` });
  await line.click();

  const sheet = page.getByRole('dialog', { name: 'Changes' });
  await expect(sheet.locator('.detail-subtitle')).toHaveText('6 files changed');
  await expect(sheet.locator('.changes-summary')).toHaveCount(0); // said once, in the header
  const files = sheet.getByRole('list', { name: 'Changed files' }).locator(':scope > li > button');
  await expect(files).toHaveCount(6);
  expect(await files.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-file-kind')))).toEqual(['modified', 'added', 'renamed', 'deleted', 'modified', 'added']);
  await expect(files.nth(2)).toContainText('setup.md → docs/setup.md');
  await expect(files.nth(4)).toContainText('binary');
  await page.screenshot({ path: `${SHOTS}/2-changes-list-light.png` });

  await files.nth(0).click();
  const body = sheet.getByRole('region', { name: 'Diff of src/server.ts' });
  await expect(body).toBeVisible();
  // git's own header lines are left out; the file header names the file.
  await expect(body).not.toContainText('diff --git');
  await expect(body).not.toContainText('index 3b18e51');
  // The long line keeps its one line: the region scrolls sideways and the code cell does not wrap.
  const long = body.locator('[data-line="add"] .code', { hasText: 'a long line' });
  expect(await long.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre');
  expect(await long.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(30);
  expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await body.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  // The page itself does not scroll sideways at 390 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/3-file-diff-light.png` });
  // Scrolled sideways, the line numbers stay pinned at the left.
  const pinned = body.locator('[data-line="add"] .ln').first();
  const code = body.locator('[data-line="add"] .code').first();
  const before = await pinned.evaluate((el) => el.getBoundingClientRect().left);
  await body.evaluate((el) => el.scrollBy({ left: 300 }));
  await expect.poll(() => body.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  expect(Math.round(await pinned.evaluate((el) => el.getBoundingClientRect().left))).toBe(Math.round(before));
  // The scrolled code slides under the line numbers: at their right edge the line numbers are on top.
  const box = await pinned.evaluate((el) => { const r = el.getBoundingClientRect(); return { right: r.right, top: r.top }; });
  expect(await code.evaluate((el) => el.getBoundingClientRect().left)).toBeLessThan(box.right - 100);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('td')?.className, { x: box.right - 4, y: box.top + 4 })).toBe('ln');
  await page.screenshot({ path: `${SHOTS}/4-file-diff-scrolled-light.png` });

  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await files.nth(5).click();
  await expect(sheet).toContainText("Only the first part of this file's changes is shown.");
  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await files.nth(4).click();
  await expect(sheet).toContainText('Binary file; no text diff.');

  await page.emulateMedia({ colorScheme: 'dark' });
  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/5-changes-list-dark.png` });
  await files.nth(0).click();
  await expect(body).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/6-file-diff-dark.png` });
});

test('a session folder outside git without agent edits: the Changes view says it is not a repository', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await request.post('/test/turn-diff', {
    data: { sessionId: 'ses_fake_1', error: { code: 'not_a_repository', message: 'Changes need a git repository in the session folder.', data: { cwd: '/w' } } },
  });
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');
  await expect(conversation.locator('.turn-changes')).toHaveCount(0); // no count without a repository
  await openCommandSheet(page);
  const sheet = page.getByRole('dialog', { name: 'Command' });
  await sheet.getByRole('tab', { name: 'Changes' }).click();
  await expect(sheet).toContainText("This folder is not a git repository, so only the agent's own edits can be shown.");
  await page.screenshot({ path: `${SHOTS}/7-not-a-repository.png` });
});

test('an agent without diffs says so in the command sheet', async ({ page, request }) => {
  await request.post('/test/no-diffs', { data: { sessionId: 'ses_fake_1' } });
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');

  // The finished command's output, from the seeded turn.
  await openCommandSheet(page);
  const command = page.getByRole('dialog', { name: 'Command' });
  await expect(command.getByLabel('Command output')).toHaveText('Created hello.txt');
  await command.getByRole('tab', { name: 'Changes' }).click();
  await expect(command).toContainText('This agent does not provide diffs.');
});

// The agent's own edits: a folder outside git, and a file outside the session folder. The
// screenshots go to /tmp/changes-shots/.
const AGENT_SHOTS = '/tmp/changes-shots';
const FOLDER = '/Users/me/Desktop/phone-test';
const NOTES_EDIT = {
  path: `${FOLDER}/notes.md`,
  kind: 'modify',
  diff: '@@ -4,7 +4,7 @@\n ## Plan\n \n - read the spec\n-- write the code\n+- write the code, with tests\n - ship it\n \n ## Done',
};
const HANDOFF_EDIT = { path: '/tmp/nano-remote-handoff.md', kind: 'add', diff: '@@ -0,0 +1,3 @@\n+# Handoff\n+\n+The changes view shows the agent edits.' };

/** A finished turn in ses_fake_3 with one file change item per edit, then a closing message. */
async function editTurn(page: Page, request: APIRequestContext, edits: Record<string, unknown>[]): Promise<void> {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/items', {
    data: { sessionId: 'ses_fake_3', items: [...edits.map((change) => ({ type: 'fileChange', changes: [change] })), { type: 'agentMessage', text: 'Done.' }] },
  });
  await page.getByRole('region', { name: 'Conversation' }).getByRole('button', { name: /previous message/ }).click();
}

test("a folder outside git: a file change row shows the agent's own diff, and the turn's Changes lists its edits", async ({ page, request }) => {
  await mkdir(AGENT_SHOTS, { recursive: true });
  await request.post('/test/turn-diff', {
    data: { sessionId: 'ses_fake_3', error: { code: 'not_a_repository', message: 'Changes need a git repository in the session folder.', data: { cwd: FOLDER } } },
  });
  await editTurn(page, request, [NOTES_EDIT]);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const line = conversation.getByRole('button', { name: '1 file changed', exact: true });
  await expect(line).toBeVisible(); // counted from the agent's edit, though git has nothing

  // The row's sheet: the edit's own diff with its line numbers.
  const fileChange = conversation.locator('[data-item="fileChange"]');
  await fileChange.getByRole('button').first().click();
  await fileChange.getByRole('button', { name: 'Show changes' }).click();
  const own = page.getByRole('dialog', { name: 'File change' });
  const body = own.getByRole('region', { name: `Diff of ${FOLDER}/notes.md` });
  await expect(body).toBeVisible();
  await expect(own).toContainText('Modified');
  await expect(own).toContainText('+1 −1');
  await expect(own).not.toContainText('git repository');
  const numbers = await body.locator('tr').evaluateAll((rows) =>
    rows.map((row) => [row.getAttribute('data-line'), row.querySelector('.ln .old')!.textContent, row.querySelector('.ln .new')!.textContent]),
  );
  expect(numbers.slice(3, 6)).toEqual([
    ['context', '6', '6'],
    ['remove', '7', ''],
    ['add', '', '7'],
  ]);
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/1-item-diff-no-git-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/2-item-diff-no-git-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await own.getByRole('button', { name: 'Close' }).click();

  // The turn's Changes: the edit, marked as the agent's, with the note saying why.
  await line.click();
  const sheet = page.getByRole('dialog', { name: 'Changes' });
  await expect(sheet.getByRole('region', { name: 'Diff of notes.md' })).toBeVisible(); // one file opens right away
  await expect(sheet).toContainText("From the agent's edits, not git");
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/3-turn-file-no-git-light.png` });
  // The list says why git has nothing.
  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await expect(sheet).toContainText("This folder is not a git repository, so only the agent's own edits can be shown.");
  await expect(sheet.getByRole('list', { name: 'Changed files' })).toContainText("From the agent's edits, not git");
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/4-turn-changes-no-git-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/5-turn-changes-no-git-dark.png` });
});

test("a git folder keeps git's diff; a file outside the folder is added from the agent's edits", async ({ page, request }) => {
  await mkdir(AGENT_SHOTS, { recursive: true });
  const git = {
    path: 'notes.md',
    kind: 'modify',
    diff: 'diff --git a/notes.md b/notes.md\nindex 1a2b3c4..5d6e7f8 100644\n--- a/notes.md\n+++ b/notes.md\n@@ -7 +7 @@\n-- write the code\n+- write the code, with tests (git)\n',
  };
  await request.post('/test/turn-diff', { data: { sessionId: 'ses_fake_3', result: { files: [git] } } });
  await editTurn(page, request, [NOTES_EDIT, HANDOFF_EDIT]);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await conversation.getByRole('button', { name: '2 files changed', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Changes' });
  const files = sheet.getByRole('list', { name: 'Changed files' }).locator(':scope > li > button');
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toContainText('notes.md');
  await expect(files.nth(0)).not.toContainText('From the agent');
  await expect(files.nth(1)).toContainText('/tmp/nano-remote-handoff.md');
  await expect(files.nth(1)).toContainText("From the agent's edits, not git");
  await expect(files.nth(1)).toContainText('Added');
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/6-turn-changes-outside-folder-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await sheetsSettled(page);
  await page.screenshot({ path: `${AGENT_SHOTS}/7-turn-changes-outside-folder-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  await files.nth(0).click();
  await expect(sheet.getByRole('region', { name: 'Diff of notes.md' }).locator('[data-line="add"] .code')).toHaveText('- write the code, with tests (git)');
  await sheet.getByRole('button', { name: 'All files', exact: true }).click();
  await files.nth(1).click();
  const outside = sheet.getByRole('region', { name: 'Diff of /tmp/nano-remote-handoff.md' });
  await expect(outside.locator('[data-line="add"]')).toHaveCount(3);
  await expect(sheet.locator('.diff-file-view')).toContainText("From the agent's edits, not git");
});
