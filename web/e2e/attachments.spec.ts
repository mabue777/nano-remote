import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Attachments from the phone (spec 8.1) against the fake host at 390 x 844: pick a large photo and a file,
// see them in the tray (the photo downscaled to 2048 px on the long edge, PNG kept), remove one, send,
// and see the thumbnail and the file chip in the transcript, also after a reload. A failed upload says so
// and retries. Screenshots go to /tmp/attachments/.

const SHOTS = '/tmp/attachments';
const SESSION = 'ses_fake_3'; // a Codex session with no turns yet

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSession(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${SESSION}`);
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
}

/** A PNG of width x height drawn in the page (a gradient, so it is not a trivial image). */
async function pngOf(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w!;
      canvas.height = h!;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, w!, h!);
      gradient.addColorStop(0, '#2f5bd3');
      gradient.addColorStop(1, '#f6c445');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w!, h!);
      context.fillStyle = '#ffffff';
      context.font = `${Math.round(h! / 5)}px sans-serif`;
      context.fillText('Nano', w! / 10, h! / 2);
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    [width, height],
  );
  return Buffer.from(base64, 'base64');
}

interface Upload {
  name: string;
  mediaType: string;
  size: number;
  width?: number;
  height?: number;
}

async function uploads(request: APIRequestContext): Promise<Upload[]> {
  return ((await (await request.post('/test/uploads')).json()) as { uploads: Upload[] }).uploads;
}

test('pick a photo and a file, preview, remove, send; the transcript shows the thumbnail and the chip', async ({ page, request }) => {
  await openSession(page, request);
  const attach = page.getByRole('button', { name: 'Attach photos or files' });
  await expect(attach).toBeVisible();
  const picker = page.locator('input.attach-input');
  // A file input without `accept` lets iOS offer the photo library, the camera and files.
  await expect(picker).not.toHaveAttribute('accept', /./);
  await expect(picker).toHaveAttribute('multiple', '');

  const photo = await pngOf(page, 3000, 1500);
  await picker.setInputFiles([
    { name: 'whiteboard.png', mimeType: 'image/png', buffer: photo },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\n') },
    { name: 'build.log', mimeType: 'text/plain', buffer: Buffer.from('error: missing semicolon\n') },
  ]);
  const tray = page.getByRole('list', { name: 'Attachments to send' });
  await expect(tray.locator('li')).toHaveCount(3);
  await expect(tray.locator('li[data-state="ready"]')).toHaveCount(3);
  await expect(tray.getByRole('img', { name: 'whiteboard.png' })).toBeVisible();
  await expect(tray).toContainText('notes.txt');
  await page.screenshot({ path: `${SHOTS}/1-picked-390.png` });

  // The photo went up downscaled to 2048 px on the long edge, still a PNG; the files as they are.
  const sent = await uploads(request);
  expect(sent.find((u) => u.name === 'whiteboard.png')).toMatchObject({ mediaType: 'image/png', width: 2048, height: 1024 });
  expect(sent.find((u) => u.name === 'notes.txt')).toMatchObject({ mediaType: 'text/plain', size: 11 });

  // Remove one before sending.
  await page.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(tray.locator('li')).toHaveCount(2);
  await expect(tray).not.toContainText('notes.txt');
  await page.screenshot({ path: `${SHOTS}/2-removed-390.png` });

  await page.getByRole('textbox', { name: 'Message' }).fill('What does the whiteboard say? The build log is attached.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('list', { name: 'Attachments to send' })).toHaveCount(0);

  // turn/start carried the text, the image and the file by their host URLs.
  const params = ((await (await request.post('/test/last', { data: { method: 'turn/start' } })).json()) as { params: { input: Record<string, string>[] } })
    .params;
  expect(params.input).toEqual([
    { type: 'text', text: 'What does the whiteboard say? The build log is attached.' },
    { type: 'image', url: expect.stringMatching(/^\/v1\/blob\/blb_/) },
    { type: 'file', url: expect.stringMatching(/^\/v1\/blob\/blb_/), name: 'build.log', mediaType: 'text/plain' },
  ]);

  const message = page.locator('[data-item="user"]').first();
  const thumbnail = message.getByRole('img', { name: 'Attached image 1' });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2048);
  const chip = message.getByRole('link', { name: /build\.log/ });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('href', params.input[2]!.url!);
  await expect(message).not.toContainText('attachment');
  await page.screenshot({ path: `${SHOTS}/3-sent-390.png` });

  // After a reload the transcript comes from the Replica and the host: the same thumbnail and chip.
  await page.reload();
  const again = page.locator('[data-item="user"]').first();
  await expect(again.getByRole('img', { name: 'Attached image 1' })).toBeVisible();
  await expect.poll(() => again.getByRole('img', { name: 'Attached image 1' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2048);
  await expect(again.getByRole('link', { name: /build\.log/ })).toBeVisible();

  // Nothing ran past the right edge at 390 px.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a failed upload says why, blocks Send, and retries', async ({ page, request }) => {
  await openSession(page, request);
  await request.post('/test/upload-fail', { data: { status: 500 } });
  await page.locator('input.attach-input').setInputFiles([{ name: 'trace.txt', mimeType: 'text/plain', buffer: Buffer.from('boom\n') }]);
  const entry = page.getByRole('list', { name: 'Attachments to send' }).locator('li');
  await expect(entry).toHaveAttribute('data-state', 'failed');
  await expect(entry.getByRole('alert')).toContainText('Upload failed: the host answered 500.');
  await expect(page.getByRole('status')).toHaveText('An attachment did not upload: retry or remove it.');
  await page.getByRole('textbox', { name: 'Message' }).fill('see trace');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/4-upload-failed-390.png` });

  await entry.getByRole('button', { name: 'Retry' }).click();
  await expect(entry).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('[data-item="user"]').first().getByRole('link', { name: /trace\.txt/ })).toBeVisible();
});

test('a file over 20 MB is refused before any upload', async ({ page, request }) => {
  await openSession(page, request);
  await page.locator('input.attach-input').setInputFiles([{ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }]);
  await expect(page.getByRole('alert').filter({ hasText: 'huge.bin is larger than 20 MB.' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Attachments to send' })).toHaveCount(0);
  expect(await uploads(request)).toEqual([]);
});
