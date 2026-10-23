import { mkdir } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('[data-item="command"]')).toContainText('npm test');
  await conversation.getByRole('button', { name: 'Details of command' }).click();

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

test('the Changes view lists the files with kind badges; a tapped file shows its diff with line numbers and colors', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/review', { data: { sessionId: 'ses_fake_3', chunks: ['ok\n'] } });
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('[data-item="command"]')).toContainText('npm test');
  await request.post('/test/review-finish', { data: { sessionId: 'ses_fake_3', changes: CHANGES } });

  // Tapping the file change item itself opens the sheet on Changes.
  const fileChange = conversation.locator('[data-item="fileChange"]');
  await expect(fileChange).toContainText('src/new.ts');
  await fileChange.click();
  const sheet = page.getByRole('dialog', { name: 'File change' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('4 files changed');
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
  const background = (kind: string) => body.locator(`[data-line="${kind}"] .code`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [added, removed, context] = [await background('add'), await background('remove'), await background('context')];
  expect(added).not.toBe(removed);
  expect(added).not.toBe(context);
  expect(removed).not.toBe(context);
  await sheet.getByRole('button', { name: '‹ All files' }).click();
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
  const line = conversation.getByRole('button', { name: '6 files changed ›' });
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

  await sheet.getByRole('button', { name: '‹ All files' }).click();
  await files.nth(5).click();
  await expect(sheet).toContainText("Only the first part of this file's changes is shown.");
  await sheet.getByRole('button', { name: '‹ All files' }).click();
  await files.nth(4).click();
  await expect(sheet).toContainText('Binary file; no text diff.');

  await page.emulateMedia({ colorScheme: 'dark' });
  await sheet.getByRole('button', { name: '‹ All files' }).click();
  await page.screenshot({ path: `${SHOTS}/5-changes-list-dark.png` });
  await files.nth(0).click();
  await expect(body).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/6-file-diff-dark.png` });
});

test('a session folder outside git: the Changes view says it needs a repository', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await request.post('/test/turn-diff', {
    data: { sessionId: 'ses_fake_1', error: { code: 'not_a_repository', message: 'Changes need a git repository in the session folder.', data: { cwd: '/w' } } },
  });
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');
  await expect(conversation.locator('.turn-changes')).toHaveCount(0); // no count without a repository
  await conversation.getByRole('button', { name: 'Details of agent message' }).click();
  const sheet = page.getByRole('dialog', { name: 'Agent message' });
  await expect(sheet).toContainText('Changes need a git repository in the session folder.');
  await page.screenshot({ path: `${SHOTS}/7-not-a-repository.png` });
});

test('an agent without diffs says so, and any item opens the sheet', async ({ page, request }) => {
  await request.post('/test/no-diffs', { data: { sessionId: 'ses_fake_1' } });
  await openSession(page, request, 'ses_fake_1');
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.locator('li[data-turn-status]')).toHaveAttribute('data-turn-status', 'completed');

  await conversation.getByRole('button', { name: 'Details of agent message' }).click();
  const sheet = page.getByRole('dialog', { name: 'Agent message' });
  await expect(sheet).toContainText('This agent does not provide diffs.');
  await expect(sheet.getByRole('tab')).toHaveCount(0); // no output for a message
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // The finished command's output, from the seeded turn.
  await conversation.getByRole('button', { name: 'Details of command' }).click();
  const command = page.getByRole('dialog', { name: 'Command' });
  await expect(command.getByLabel('Command output')).toHaveText('Created hello.txt');
  await command.getByRole('tab', { name: 'Changes' }).click();
  await expect(command).toContainText('This agent does not provide diffs.');
});
