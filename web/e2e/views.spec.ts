import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The review views against the fake host (test/e2e-server.ts): the item detail sheet opened from the turn
// list, with the output of a command (streamed, ANSI stripped, wrapped, followed, copyable) and the diff of
// the turn (a section per file, kinds, colored lines), plus an agent that does not provide diffs.

const ESC = '\u001b';
const LONG = `${'very-long-path-segment/'.repeat(12)}end`;
/** 40 colored lines, one of them far wider than a phone. */
const CHUNKS = Array.from({ length: 40 }, (_, i) => `${ESC}[32m✓${ESC}[0m ${ESC}[1mtest ${i + 1}${ESC}[22m passed${i === 5 ? ` ${LONG}` : ''}\r\n`);
const PLAIN = Array.from({ length: 40 }, (_, i) => `✓ test ${i + 1} passed${i === 5 ? ` ${LONG}` : ''}\n`).join('');

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

test('the diff view shows a section per file with its kind and colored lines', async ({ page, request }) => {
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
  const files = sheet.getByRole('list', { name: 'Changed files' }).locator(':scope > li');
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

  // Several files: sections start collapsed and open one at a time.
  const head = files.nth(1).getByRole('button');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet.getByRole('region', { name: 'Diff of src/app.ts' })).toHaveCount(0);
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  const body = sheet.getByRole('region', { name: 'Diff of src/app.ts' });
  await expect(body.locator('[data-line="remove"]')).toHaveText('−const a = 1;');
  await expect(body.locator('[data-line="add"]')).toHaveText('+const a = 2;');
  await expect(body.locator('[data-line="context"]')).toHaveCount(2);
  const background = (kind: string) => body.locator(`[data-line="${kind}"]`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [added, removed, context] = [await background('add'), await background('remove'), await background('context')];
  expect(added).not.toBe(removed);
  expect(added).not.toBe(context);
  expect(removed).not.toBe(context);
  await head.click();
  await expect(body).toHaveCount(0);
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
