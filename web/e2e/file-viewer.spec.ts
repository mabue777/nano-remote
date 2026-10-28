import { mkdir } from 'node:fs/promises';

import { sheetsClosed, sheetsSettled } from './sheets';
import { expect, test, type APIRequestContext, type Page } from './worker-host';

// The text file viewer (docs/plan/file-viewer.md item P3) against the fake host's session folder
// (test/e2e-server.ts SEEDED_FILES, read through fs/readFile and /v1/file): a pushed page titled with the file
// name, its folder under it; SF Mono lines with a pinned gutter, rendered in windows; wrap per kind; find with
// a count and a case toggle; markdown rendered or raw; "Show more" for a file over 256 KiB; a binary card; a
// path:line jump that scrolls to and tints the line. Screenshots at 390 x 844, light and dark, go to
// /tmp/brocode-rvc.3-shots/.

const SHOTS = '/tmp/brocode-rvc.3-shots';
const SESSION = 'ses_fake_1';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

function fileUrl(path: string, line?: number): string {
  const query = new URLSearchParams({ path });
  if (line !== undefined) query.set('line', String(line));
  return `/s/${SESSION}/file?${query.toString()}`;
}

async function openFile(page: Page, path: string, line?: number): Promise<void> {
  await page.goto(fileUrl(path, line));
  await expect(page.locator('.file-viewer')).toBeVisible();
}

/** Whether a line's row lies in the viewport below the sticky header. */
async function lineInView(page: Page, index: number): Promise<boolean> {
  return page.evaluate((i) => {
    const row = document.querySelector(`.file-viewer [data-line="${i}"]`);
    if (row === null) return false;
    const header = document.querySelector('.file-top')!.getBoundingClientRect().bottom;
    const rect = row.getBoundingClientRect();
    return rect.top >= header - 1 && rect.bottom <= window.innerHeight + 1;
  }, index);
}

test('a code file: title and folder, numbered lines in SF Mono, unwrapped with a pinned gutter, windowed', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'src/parser.ts');
  const header = page.locator('.file-top .nav');
  await expect(header.getByRole('heading', { name: 'parser.ts' })).toBeVisible();
  await expect(header.locator('.file-folder')).toHaveText('src');
  await expect(page.getByRole('link', { name: 'Session' })).toBeVisible();

  const first = page.locator('[data-line="0"]');
  await expect(first.locator('.file-gutter')).toHaveText('1');
  await expect(first.locator('.file-code')).toHaveText('// The parser of the phone-test project.');
  const font = await first.locator('.file-code').evaluate((el) => {
    const style = getComputedStyle(el);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
  });
  expect(font.family).toContain('ui-monospace');
  expect(font).toMatchObject({ size: '13px', lineHeight: '18px' });

  // Code does not wrap: the long line scrolls sideways, and the gutter stays put while it does.
  const text = page.locator('.file-text');
  expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth + 100)).toBe(true);
  const gutterLeft = () => page.locator('[data-line="9"] .file-gutter').evaluate((el) => Math.round(el.getBoundingClientRect().left));
  const before = await gutterLeft();
  await text.evaluate((el) => (el.scrollLeft = 200));
  await expect.poll(() => text.evaluate((el) => el.scrollLeft)).toBe(200);
  expect(await gutterLeft()).toBe(before);

  // 1200 lines, but only the blocks near the viewport are in the page.
  const rendered = await page.locator('.file-line').count();
  expect(rendered).toBeGreaterThan(40);
  expect(rendered).toBeLessThanOrEqual(500);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('[data-line="1199"]')).toBeVisible();
  await expect.poll(() => lineInView(page, 1199)).toBe(true);
  expect(await page.locator('[data-line="0"]').count()).toBe(0);
  expect(await page.locator('.file-line').count()).toBeLessThanOrEqual(500);

  // Back goes to the session.
  await page.getByRole('link', { name: 'Session' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`));
  await expect(page.getByRole('heading', { name: 'Create hello.txt and list files' })).toBeVisible();
});

test('find counts matches, steps with wrap-around, toggles case, and Escape closes it', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'src/parser.ts');
  await page.getByRole('button', { name: 'Find in file' }).click();
  const field = page.getByRole('searchbox', { name: 'Find in file' });
  await expect(field).toBeFocused();
  await field.fill('todo');
  const count = page.locator('.find-count');
  await expect(count).toHaveText('1 of 48');
  await expect(page.locator('mark.find-hit.current')).toHaveText('TODO');
  await expect.poll(() => lineInView(page, 24)).toBe(true);

  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(count).toHaveText('2 of 48');
  await field.press('Enter');
  await expect(count).toHaveText('3 of 48');
  await field.press('Shift+Enter');
  await expect(count).toHaveText('2 of 48');

  // Previous from the first wraps to the last match, far below the rendered window.
  await page.getByRole('button', { name: 'Previous match' }).click();
  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(count).toHaveText('48 of 48');
  await expect.poll(() => lineInView(page, 1199)).toBe(true);
  await expect(page.locator('[data-line="1199"] mark.find-hit.current')).toHaveText('TODO');

  // Case: "todo" no longer matches "TODO".
  const caseToggle = page.getByRole('button', { name: 'Match case' });
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(count).toHaveText('No results');
  await field.fill('TODO');
  await expect(count).toHaveText(/ of 48$/);

  // Escape closes the find bar first, then the page.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('search')).toHaveCount(0);
  await expect(page.locator('mark.find-hit')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`));
});

test('a path:line jump scrolls to the line and tints it once; Reduce Motion tints without a fade', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'src/parser.ts', 600);
  await expect.poll(() => lineInView(page, 599)).toBe(true);
  await expect(page.locator('[data-line="599"]')).toHaveClass(/flash/);
  await expect(page.locator('[data-line="599"]')).not.toHaveClass(/flash/, { timeout: 4000 });

  // The `:line` form of the path works too.
  await openFile(page, 'src/parser.ts:900');
  await expect.poll(() => lineInView(page, 899)).toBe(true);
  await expect(page.locator('.file-folder')).toHaveText('src');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFile(page, 'src/parser.ts', 300);
  const row = page.locator('[data-line="299"]');
  await expect(row).toHaveClass(/flash/);
  expect(await row.evaluate((el) => el.getAnimations().length)).toBe(0);
});

test('markdown shows rendered or raw; wrap is on for prose, off for code, and remembered per kind', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'README.md');
  const rendered = page.getByRole('article', { name: 'Rendered markdown' });
  await expect(rendered.getByRole('heading', { name: 'phone-test' })).toBeVisible();
  await expect(rendered.locator('strong')).toHaveText('agent');
  await expect(page.locator('.file-folder')).toHaveText('phone-test');

  const menu = async () => {
    await page.getByRole('button', { name: 'File actions' }).click();
    const sheet = page.getByRole('dialog', { name: 'README.md' }).or(page.getByRole('dialog', { name: 'notes.txt' }));
    await expect(sheet).toBeVisible();
    await sheetsSettled(page);
    return sheet;
  };
  let sheet = await menu();
  await expect(sheet.locator('[data-row="rendered"]')).toContainText('Rendered');
  await expect(sheet.locator('[data-row="wrap"]')).toContainText('On');
  await sheet.locator('[data-row="rendered"] button').click();
  await sheetsClosed(page);
  await expect(page.locator('[data-line="0"] .file-code')).toHaveText('# phone-test');

  // Opening find on rendered markdown shows it raw, where matches can be marked.
  await page.getByRole('button', { name: 'File actions' }).click();
  await sheetsSettled(page);
  await page.getByRole('dialog').locator('[data-row="rendered"] button').click();
  await sheetsClosed(page);
  await expect(rendered).toBeVisible();
  await page.getByRole('button', { name: 'Find in file' }).click();
  await page.getByRole('searchbox', { name: 'Find in file' }).fill('npm');
  await expect(page.locator('.find-count')).toHaveText('1 of 1');
  await expect(rendered).toHaveCount(0);

  // Text wraps by default; turning it off is remembered for text files on a reload, not for markdown.
  await openFile(page, 'notes.txt');
  const text = page.locator('.file-text');
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  sheet = await menu();
  await sheet.locator('[data-row="wrap"] button').click();
  await sheetsClosed(page);
  await expect(page.locator('.file-viewer')).not.toHaveClass(/wrapped/);
  expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('[data-line="1"]')).toBeVisible();
  await expect(page.locator('.file-viewer')).not.toHaveClass(/wrapped/);
  await openFile(page, 'README.md');
  await expect(page.locator('.file-viewer')).toHaveClass(/wrapped/);
});

test('Copy path and Copy all put the text on the clipboard', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await pair(page, request);
  await openFile(page, 'notes.txt');
  await page.getByRole('button', { name: 'File actions' }).click();
  await sheetsSettled(page);
  await page.getByRole('dialog').locator('[data-row="copy-path"] button').click();
  await expect(page.getByRole('status')).toHaveText('Path copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('notes.txt');
  await sheetsClosed(page);
  await page.getByRole('button', { name: 'File actions' }).click();
  await sheetsSettled(page);
  await page.getByRole('dialog').locator('[data-row="copy-all"] button').click();
  await expect(page.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Plain notes.\nA second line');
});

test('a file over 256 KiB shows its first part and "Show more" reads the next range', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'logs/big.log');
  const footer = page.locator('.file-more');
  await expect(footer).toContainText(/Showing 262 KB of 3\d\d KB/);
  await expect(page.locator('[data-line="0"]')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await footer.getByRole('button', { name: 'Show more' }).click();
  await expect(footer).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('[data-line="8999"] .file-code')).toHaveText('09000 INFO request served in 75 ms');
  await expect(page.locator('[data-line="8999"] .file-gutter')).toHaveText('9000');
});

test('a binary file shows a card with its kind, size and a way to save it; /v1/file revalidates and serves ranges', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'logo.png');
  const card = page.getByRole('region', { name: 'File' });
  await expect(card.getByRole('heading', { name: 'PNG image' })).toBeVisible();
  await expect(card).toContainText('70 bytes · Modified');
  const download = card.getByRole('link', { name: 'Download' });
  await expect(download).toHaveAttribute('href', `/v1/file?sessionId=${SESSION}&path=logo.png`);
  await expect(page.getByRole('button', { name: 'Find in file' })).toHaveCount(0);

  const answers = await page.evaluate(async (url) => {
    const full = await fetch(url);
    const etag = full.headers.get('etag')!;
    const again = await fetch(url, { headers: { 'if-none-match': etag }, cache: 'no-store' });
    const part = await fetch(url, { headers: { range: 'bytes=0-7' }, cache: 'no-store' });
    const past = await fetch(url, { headers: { range: 'bytes=999-' }, cache: 'no-store' });
    const outside = await fetch('/v1/file?sessionId=ses_fake_1&path=..%2Fsecret', { cache: 'no-store' });
    return {
      full: [full.status, full.headers.get('content-type'), full.headers.get('accept-ranges'), (await full.arrayBuffer()).byteLength],
      again: again.status,
      part: [part.status, part.headers.get('content-range'), (await part.arrayBuffer()).byteLength],
      past: past.status,
      outside: outside.status,
    };
  }, '/v1/file?sessionId=ses_fake_1&path=logo.png');
  expect(answers).toEqual({ full: [200, 'image/png', 'bytes', 70], again: 304, part: [206, 'bytes 0-7/70', 8], past: 416, outside: 404 });
});

test('a missing file or a path outside the session folder says so; an empty file says it is empty', async ({ page, request }) => {
  await pair(page, request);
  await openFile(page, 'nope.ts');
  await expect(page.getByRole('alert')).toHaveText('That file is not in the session folder.');
  await openFile(page, '../../etc/passwd');
  await expect(page.getByRole('alert')).toHaveText('That file is not in the session folder.');
  await openFile(page, 'src');
  await expect(page.getByRole('alert')).toContainText('This is not a file that can be shown here.');
  await openFile(page, 'empty.txt');
  await expect(page.getByText('This file is empty.')).toBeVisible();
});

test('the header does not move when the file finishes loading', async ({ page, request }) => {
  await pair(page, request);
  await request.post('/test/delay', { data: { method: 'fs/readFile', ms: 600 } });
  await page.goto(fileUrl('src/parser.ts'));
  await expect(page.getByText('Loading…')).toBeVisible();
  const box = () => page.locator('.file-top .nav').evaluate((el) => JSON.stringify(el.getBoundingClientRect()));
  const loading = await box();
  await expect(page.locator('[data-line="0"]')).toBeVisible();
  expect(await box()).toBe(loading);
});

test('screenshots: code with find, rendered markdown, the menu and a binary card, light and dark', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await pair(page, request);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openFile(page, 'src/parser.ts', 20);
    await expect.poll(() => lineInView(page, 19)).toBe(true);
    await page.getByRole('button', { name: 'Find in file' }).click();
    await page.getByRole('searchbox', { name: 'Find in file' }).fill('input');
    await expect(page.locator('.find-count')).toHaveText(/ of /);
    await page.screenshot({ path: `${SHOTS}/code-find-${scheme}.png` });

    await openFile(page, 'README.md');
    await expect(page.getByRole('article', { name: 'Rendered markdown' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/markdown-${scheme}.png` });
    await page.getByRole('button', { name: 'File actions' }).click();
    await sheetsSettled(page);
    await page.screenshot({ path: `${SHOTS}/menu-${scheme}.png` });

    await openFile(page, 'logo.png');
    await expect(page.getByRole('heading', { name: 'PNG image' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/binary-${scheme}.png` });

    await openFile(page, 'logs/big.log');
    await expect(page.locator('[data-line="0"]')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.getByRole('button', { name: 'Show more' })).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/show-more-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
});
