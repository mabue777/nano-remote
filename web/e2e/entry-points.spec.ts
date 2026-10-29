import { mkdir } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page } from './worker-host';

// Entry points into the file viewer (docs/plan/file-viewer.md item P4): a "View file" button in the Changes
// diff, tappable paths in "Edited ..." rows and their expanded lists, linkified paths in agent messages, and
// text file attachment chips that open from /v1/blob. Screenshots at 390 x 844, light and dark, go to
// /tmp/brocode-rvc.4-shots/.

const SHOTS = '/tmp/brocode-rvc.4-shots';
const SESSION = 'ses_fake_1';

interface BlobUpload {
  blobId: string;
  url: string;
  name: string;
  mediaType: string;
  size: number;
}

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openSession(page: Page): Promise<void> {
  await page.goto(`/s/${SESSION}`);
  await expect(page.locator('.session-screen')).toBeVisible();
}

async function addItems(page: Page, request: APIRequestContext, items: unknown[]): Promise<void> {
  const response = await request.post('/test/items', { data: { sessionId: SESSION, items } });
  expect(response.ok()).toBe(true);
  // Give the Replica a frame to apply the new turn before the browser asks for its view.
  await page.waitForTimeout(50);
}

async function uploadText(page: Page, name: string, text: string): Promise<BlobUpload> {
  const response = await page.request.post(`/v1/blob?sessionId=${SESSION}&name=${encodeURIComponent(name)}`, {
    headers: { 'content-type': 'text/plain' },
    data: text,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as BlobUpload;
}

function filePathFromUrl(): (url: URL) => boolean {
  return (url) => url.pathname === `/s/${SESSION}/file`;
}

test('View file button in the Changes diff opens the file page', async ({ page, request }) => {
  await pair(page, request);
  await addItems(page, request, [
    { type: 'userMessage', content: [{ type: 'text', text: 'Update the parser.' }] },
    { type: 'agentMessage', text: 'Done.' },
    { type: 'fileChange', changes: [{ path: 'src/parser.ts', kind: 'modify', diff: '-old\n+new\n' }] },
  ]);
  await openSession(page);
  await page.getByText('1 file changed').click();
  await page.getByText('src/parser.ts').first().click();
  const viewFile = page.getByRole('button', { name: 'View file' });
  await expect(viewFile).toBeVisible();
  await mkdir(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/view-file-button-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await viewFile.click();
  await expect(page).toHaveURL((url) => url.pathname === `/s/${SESSION}/file` && url.searchParams.get('path') === 'src/parser.ts');
  await expect(page.getByRole('heading', { name: 'parser.ts' })).toBeVisible();
  // The sheet closed on the way: going back shows the transcript, not the Changes sheet.
  await page.goBack();
  await expect(page.locator('.session-screen')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Changes' })).toHaveCount(0);
});

test('the path in an Edited row opens the file viewer', async ({ page, request }) => {
  await pair(page, request);
  await addItems(page, request, [
    { type: 'fileChange', changes: [{ path: 'src/parser.ts', kind: 'modify', diff: '-old\n+new\n' }] },
  ]);
  await openSession(page);
  await page.getByText(/\d+ previous message/).last().click();
  const target = page.locator('[data-item="fileChange"] .row-target');
  await expect(target).toHaveText('src/parser.ts');
  await target.click();
  await expect(page).toHaveURL(filePathFromUrl());
  await expect(page.getByRole('heading', { name: 'parser.ts' })).toBeVisible();
});

test('a path in an expanded file-change row opens the file viewer', async ({ page, request }) => {
  await pair(page, request);
  await addItems(page, request, [
    {
      type: 'fileChange',
      changes: [
        { path: 'src/parser.ts', kind: 'modify', diff: '-old\n+new\n' },
        { path: 'README.md', kind: 'modify', diff: '-old\n+new\n' },
      ],
    },
  ]);
  await openSession(page);
  await page.getByText(/\d+ previous message/).last().click();
  await page.locator('[data-item="fileChange"] .row-line').click();
  const pathLink = page.locator('[data-item="fileChange"] .paths .file-link').filter({ hasText: 'README.md' });
  await pathLink.click();
  await expect(page).toHaveURL(filePathFromUrl());
  await expect(page.getByRole('heading', { name: 'README.md' })).toBeVisible();
});

test('agent-message paths become links; a missing file says so', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await pair(page, request);
  await addItems(page, request, [
    {
      type: 'agentMessage',
      text: 'See src/parser.ts:12 and missing.txt. e.g. and http://example.com/file.ts should not link.',
    },
  ]);
  await openSession(page);
  const lastMessage = page.locator('.msg.agent').last();
  const links = lastMessage.locator('.file-link');
  await expect(links.filter({ hasText: 'src/parser.ts:12' })).toBeVisible();
  await expect(links.filter({ hasText: 'missing.txt' })).toBeVisible();
  await expect(links.filter({ hasText: 'http://' })).toHaveCount(0);

  await links.filter({ hasText: 'src/parser.ts:12' }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('path') === 'src/parser.ts' && url.searchParams.get('line') === '12');
  await expect(page.getByRole('heading', { name: 'parser.ts' })).toBeVisible();

  // A link to a missing file shows the not_found message.
  await page.goto(`/s/${SESSION}`);
  await page.locator('.msg.agent').last().locator('.file-link').filter({ hasText: 'missing.txt' }).click();
  await expect(page).toHaveURL(filePathFromUrl());
  await expect(page.getByRole('alert')).toHaveText('That file is not in the session folder.');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/not-found-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
});

test('a text file attachment chip opens in the viewer from /v1/blob', async ({ page, request }) => {
  await pair(page, request);
  const blob = await uploadText(page, 'notes.txt', 'Attached notes.\nSecond line.\n');
  await addItems(page, request, [
    {
      type: 'userMessage',
      content: [{ type: 'file', url: blob.url, name: blob.name, mediaType: blob.mediaType }],
    },
  ]);
  await openSession(page);
  const chip = page.locator('.file-chip').filter({ hasText: 'notes.txt' });
  await chip.click();
  await expect(page).toHaveURL((url) => url.pathname === `/s/${SESSION}/file` && url.searchParams.get('path') === blob.url);
  await expect(page.getByRole('heading', { name: 'notes.txt' })).toBeVisible();
  await expect(page.locator('[data-line="0"] .file-code')).toHaveText('Attached notes.');
});

test('screenshots: linkified paths and an expanded file-change row, light and dark', async ({ page, request }) => {
  await mkdir(SHOTS, { recursive: true });
  await pair(page, request);
  await addItems(page, request, [
    { type: 'agentMessage', text: 'I updated src/parser.ts and README.md.' },
    {
      type: 'fileChange',
      changes: [
        { path: 'src/parser.ts', kind: 'modify', diff: '-old\n+new\n' },
        { path: 'README.md', kind: 'modify', diff: '-old\n+new\n' },
      ],
    },
  ]);
  await openSession(page);
  await page.getByText(/\d+ previous message/).last().click();
  await page.locator('[data-item="fileChange"] .row-line').click();
  await expect(page.locator('[data-item="fileChange"] .paths .file-link')).toHaveCount(2);
  // Let the row's reveal settle before the picture.
  await page.waitForTimeout(600);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}/entry-points-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
});
