import { mkdir } from 'node:fs/promises';

import { sheetsSettled } from './sheets';
import { expect, test, type APIRequestContext, type Page } from './worker-host';

// The Files page (docs/plan/file-viewer.md item P6): a pushed page listing the session folder, Files-app rows
// with icons, names, meta lines and chevrons, folders first, hidden files behind a switch, pull-to-refresh,
// and a dot + "changed" on files the last turn touched. Tapping a folder pushes deeper; tapping a file opens
// the text viewer or the image viewer. Screenshots at 390 x 844, light and dark, go to /tmp/brocode-rvc.6-shots/.

const SHOTS = '/tmp/brocode-rvc.6-shots';
const SESSION = 'ses_fake_1';

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openFiles(page: Page): Promise<void> {
  await page.goto(`/s/${SESSION}/files`);
  await expect(page.locator('.folder-page')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

test('lists the session folder: folders first, Files-app rows with meta, chevron on folders', async ({ page, request }) => {
  await pair(page, request);
  await openFiles(page);
  const header = page.locator('.folder-top .nav');
  await expect(header.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(header.locator('.file-folder')).toContainText('phone-test');

  // Folders first, then files; the logs folder sorts before src.
  const rows = page.locator('.folder-list [data-row]');
  await expect(rows.first()).toHaveAttribute('data-row', 'logs');
  await expect(rows.first().locator('.icon-folder')).toHaveCount(1);
  await expect(rows.first().locator('.chevron')).toHaveCount(1);

  // A file row shows the icon, name and a meta line with size and date.
  const readme = page.locator('[data-row="README.md"]');
  await expect(readme).toContainText('README.md');
  await expect(readme.locator('.icon-file')).toHaveCount(1);
  await expect(readme.locator('.group-value')).toContainText(/bytes/);

  // A changed file carries the dot + "changed" word.
  // The seeded turn does not change files, so we add a file and mark it changed by editing it in a review turn.
  await request.post('/test/file', { data: { sessionId: SESSION, path: 'new.txt', text: 'hello' } });
  await request.post('/test/review', { data: { sessionId: SESSION, chunks: [] } });
  await request.post('/test/review-finish', { data: { sessionId: SESSION, changes: [{ path: 'new.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+hello\n' }] } });
  await page.reload();
  await expect(page.locator('[data-row="new.txt"] .status-word')).toContainText('changed');

  // Tapping a folder pushes the next level.
  await page.locator('[data-row="src"]').click();
  await expect(page).toHaveURL(/\/s\/ses_fake_1\/files\?path=src/);
  await expect(page.locator('.folder-top .nav')).toContainText('src');
  await expect(page.locator('.folder-list [data-row]').first()).toBeVisible();
  await expect(page.locator('[data-row="src/parser.ts"]')).toBeVisible();
  await page.getByRole('link', { name: 'Session' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`));
});

test('hidden files switch and cap', async ({ page, request }) => {
  await pair(page, request);
  await request.post('/test/file', { data: { sessionId: SESSION, path: '.secret', text: 'shh' } });
  await openFiles(page);
  await expect(page.locator('[data-row=".secret"]')).toHaveCount(0);
  const toggle = page.getByRole('switch', { name: 'Show hidden files' });
  await toggle.click();
  await expect(page.locator('[data-row=".secret"]')).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('pull to refresh re-reads the folder', async ({ page, request }) => {
  await pair(page, request);
  await openFiles(page);
  await expect(page.locator('[data-row="fresh.txt"]')).toHaveCount(0);
  await request.post('/test/file', { data: { sessionId: SESSION, path: 'fresh.txt', text: 'new' } });
  const list = page.locator('.folder-list');
  await list.evaluate((el) => (el.scrollTop = 0));
  const box = await list.boundingBox();
  expect(box).not.toBeNull();
  const touch = (y: number) => ({ touches: [{ identifier: 1, clientX: Math.round(box!.x + box!.width / 2), clientY: y }], changedTouches: [{ identifier: 1, clientX: Math.round(box!.x + box!.width / 2), clientY: y }] });
  await list.dispatchEvent('touchstart', touch(Math.round(box!.y + 80)));
  await list.dispatchEvent('touchmove', touch(Math.round(box!.y + 180)));
  await list.dispatchEvent('touchmove', touch(Math.round(box!.y + 260)));
  await list.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: Math.round(box!.x + box!.width / 2), clientY: Math.round(box!.y + 260) }] });
  await expect(page.locator('[data-row="fresh.txt"]')).toBeVisible();
});

test('tapping a text file opens the file viewer; an image opens the image viewer', async ({ page, request }) => {
  await pair(page, request);
  await openFiles(page);
  await page.locator('[data-row="README.md"]').click();
  await expect(page.locator('.file-viewer')).toBeVisible();
  await expect(page.locator('.file-top .nav')).toContainText('README.md');

  await page.goto(`/s/${SESSION}/files`);
  await expect(page.locator('.folder-page')).toBeVisible();
  await page.locator('[data-row="logo.png"]').click();
  await expect(page.locator('.iv')).toBeVisible();
});

test('the Files entry appears in the session details sheet', async ({ page, request }) => {
  await pair(page, request);
  await page.goto(`/s/${SESSION}`);
  await page.getByRole('button', { name: 'Session details' }).click();
  await sheetsSettled(page);
  const filesRow = page.locator('[data-row="files"]');
  await expect(filesRow).toContainText('Files');
  await filesRow.locator('button').click();
  await expect(page).toHaveURL(/\/s\/ses_fake_1\/files/);
  await expect(page.locator('.folder-page')).toBeVisible();
});

test('screenshots: the folder page and the hidden switch, light and dark', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await pair(page, request);
  await openFiles(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('[data-row="src"]')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/files-${scheme}.png` });
    const toggle = page.getByRole('switch', { name: 'Show hidden files' });
    await toggle.click();
    await page.screenshot({ path: `${SHOTS}/files-hidden-${scheme}.png` });
    await toggle.click();
  }
  await page.emulateMedia({ colorScheme: 'light' });
});
