import { mkdirSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

// The send flow of image markup (docs/plan/image-markup.md, ticket 4) against the fake host at 390 x 844: attach
// a screenshot, tap its thumbnail, mark it (a rectangle and two comments), Done; the tray shows the marked picture
// with a badge and uploads it instead of the original; re-opening keeps the marks editable; Remove asks first; Send
// carries the marked picture as an ordinary image part and the comments as numbered lines under the text, and the
// sent bubble shows both. A failed upload of the marked picture retries the marked picture.
// Screenshots go to /tmp/brocode-xu4.4-shots/ (not the repo).

const SHOTS = '/tmp/brocode-xu4.4-shots';
mkdirSync(SHOTS, { recursive: true });
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

/** A plain light-grey PNG screenshot of width x height, drawn in the page. */
async function screenshotPng(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w!;
      canvas.height = h!;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#e8e8e8';
      context.fillRect(0, 0, w!, h!);
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    [width, height],
  );
  return Buffer.from(base64, 'base64');
}

interface Upload {
  blobId: string;
  name: string;
  mediaType: string;
  size: number;
  width?: number;
  height?: number;
}

async function uploads(request: APIRequestContext): Promise<Upload[]> {
  return ((await (await request.post('/test/uploads')).json()) as { uploads: Upload[] }).uploads;
}

type Touch = [type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number];

/** One-finger touch events on the canvas, positions from its top-left corner. */
async function touch(canvas: Locator, events: Touch[]): Promise<void> {
  await canvas.evaluate((el, list) => {
    const rect = el.getBoundingClientRect();
    for (const [type, x, y] of list) {
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: type === 'pointermove' ? -1 : 0 }));
    }
  }, events);
}

async function tap(canvas: Locator, x: number, y: number): Promise<void> {
  await touch(canvas, [
    ['pointerdown', x, y],
    ['pointerup', x, y],
  ]);
}

async function drag(canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const moves: Touch[] = [];
  for (let i = 1; i <= 8; i++) moves.push(['pointermove', from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8]);
  await touch(canvas, [['pointerdown', ...from], ...moves, ['pointerup', ...to]]);
}

async function write(page: Page, title: string, text: string): Promise<void> {
  const sheet = page.getByRole('dialog', { name: title });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: title }).fill(text);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
}

async function openCover(page: Page, name: string): Promise<{ cover: Locator; canvas: Locator }> {
  await page.getByRole('list', { name: 'Attachments to send' }).getByRole('button', { name: `Mark up ${name}` }).click();
  const cover = page.getByRole('dialog', { name: 'Mark up' });
  const canvas = cover.locator('canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(700); // the rise has settled
  return { cover, canvas };
}

/** The colour of the pixel at (x, y) of a stored blob, read in the page (the device cookie fetches it). */
async function pixel(page: Page, url: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([src, px, py]) => {
      const bitmap = await createImageBitmap(await (await fetch(src as string)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return [...context.getImageData(px as number, py as number, 1, 1).data];
    },
    [url, x, y] as const,
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test(`attach, mark, Done, badge, re-open, remove asks, send (${scheme}): the agent gets the marked picture and the numbered lines`, async ({ page, request }) => {
    test.setTimeout(60_000); // the whole flow: attach, mark, re-open, remove, send
    await page.emulateMedia({ colorScheme: scheme });
    await openSession(page, request);
    await page.locator('input.composer-file').setInputFiles([{ name: 'screen.png', mimeType: 'image/png', buffer: await screenshotPng(page, 1000, 2000) }]);
    const tray = page.getByRole('list', { name: 'Attachments to send' });
    const entry = tray.locator('li');
    await expect(entry).toHaveAttribute('data-state', 'ready');
    expect(await uploads(request)).toHaveLength(1);

    // Tap the thumbnail: the cover, on the picture; a rectangle and two comments (one on the rectangle).
    const { cover, canvas } = await openCover(page, 'screen.png');
    const tools = cover.getByRole('group', { name: 'Tool' });
    await tools.getByRole('button', { name: 'Rectangle' }).click();
    const box = (await canvas.boundingBox())!;
    // The 1:2 picture is fitted into the stage: its height fills the stage, centred across.
    const scale = box.height / 2000;
    const left = (box.width - 1000 * scale) / 2;
    const at = (x: number, y: number): [number, number] => [left + x * scale, y * scale];
    await drag(canvas, at(200, 400), at(600, 800));
    await tap(canvas, ...at(400, 400)); // on the rectangle's top edge: its comment
    await write(page, 'Comment 1', 'this card is misaligned');
    await tools.getByRole('button', { name: 'Comment' }).click();
    await tap(canvas, ...at(700, 1500));
    await write(page, 'Comment 2', 'wrong colour here');
    await page.screenshot({ path: `${SHOTS}/${scheme}-1-marked.png` });
    await cover.getByRole('button', { name: 'Done' }).click();
    await expect(cover).toHaveCount(0);

    // The tray: the marked picture with a badge (2 comments), uploaded instead of the original.
    await expect(entry).toHaveAttribute('data-marked', 'true');
    await expect(entry).toHaveAttribute('data-state', 'ready');
    await expect(entry).toHaveAttribute('aria-label', 'screen.png, marked, 2 comments: Ready');
    await expect(entry.locator('.tray-badge')).toHaveText('2');
    await expect.poll(async () => (await uploads(request)).length).toBe(2);
    const marked = (await uploads(request))[1]!;
    expect(marked).toMatchObject({ name: 'screen.png', mediaType: 'image/png', width: 1000, height: 2000 });
    await page.screenshot({ path: `${SHOTS}/${scheme}-2-badge.png` });

    // Re-open: the marks are still there and editable; Cancel without a change asks nothing.
    const again = await openCover(page, 'screen.png');
    await expect(again.cover.getByRole('list', { name: 'Comments' }).getByRole('button')).toHaveText(['Comment 1: this card is misaligned', 'Comment 2: wrong colour here']);
    await expect(again.canvas).toHaveAttribute('aria-label', 'screen.png, 1 mark, 2 comments');
    await page.screenshot({ path: `${SHOTS}/${scheme}-3-reopened.png` });
    await again.cover.getByRole('button', { name: 'Cancel' }).click();
    await expect(again.cover).toHaveCount(0);
    expect(await uploads(request)).toHaveLength(2);

    // Remove asks first; Keep keeps it.
    await page.getByRole('button', { name: 'Remove screen.png' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove the marked picture?' });
    await expect(confirm).toContainText('Your marks and 2 comments on screen.png go with it.');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/${scheme}-4-remove-asks.png` });
    await confirm.getByRole('button', { name: 'Keep' }).click();
    await expect(confirm).toBeHidden();
    await expect(entry).toHaveCount(1);

    // Send: the text gets the numbered lines; the image part is the marked upload.
    await page.getByRole('textbox', { name: 'Message' }).fill('Please fix these.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(tray).toHaveCount(0);
    const params = ((await (await request.post('/test/last', { data: { method: 'turn/start' } })).json()) as { params: { input: Record<string, string>[] } }).params;
    expect(params.input).toEqual([
      {
        type: 'text',
        text: [
          'Please fix these.',
          '',
          'Marks on the attached image (the numbers match the pins):',
          '1. this card is misaligned (around 20-60% across, 20-40% down)',
          '2. wrong colour here (at 70% across, 75% down)',
        ].join('\n'),
      },
      { type: 'image', url: `/v1/blob/${marked.blobId}` },
    ]);
    // The marks are burned in: the rectangle's edge is red, the inside still the screenshot's grey.
    const [r, g, b] = await pixel(page, `/v1/blob/${marked.blobId}`, 400, 400);
    expect(r).toBeGreaterThan(200);
    expect(g! + b!).toBeLessThan(200);
    expect(await pixel(page, `/v1/blob/${marked.blobId}`, 400, 600)).toEqual([232, 232, 232, 255]);

    // The sent bubble shows what the agent saw: the marked picture and the lines.
    const message = page.locator('[data-item="user"]').first();
    await expect(message).toContainText('Marks on the attached image (the numbers match the pins):');
    await expect(message).toContainText('2. wrong colour here (at 70% across, 75% down)');
    await expect(message.getByRole('img', { name: 'Attached image 1' })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/${scheme}-5-sent.png` });
  });
}

test('remove of a marked picture, confirmed; a failed upload of the marked picture retries it', async ({ page, request }) => {
  test.setTimeout(60_000); // two pictures marked, one upload failed and retried
  await openSession(page, request);
  await page.locator('input.composer-file').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: await screenshotPng(page, 600, 600) },
    { name: 'two.png', mimeType: 'image/png', buffer: await screenshotPng(page, 600, 600) },
  ]);
  const tray = page.getByRole('list', { name: 'Attachments to send' });
  await expect(tray.locator('li[data-state="ready"]')).toHaveCount(2);

  // Mark one.png (a pen stroke, no comments): the badge is the pen alone; Remove asks and removes.
  let { cover, canvas } = await openCover(page, 'one.png');
  await drag(canvas, [100, 200], [250, 300]);
  await cover.getByRole('button', { name: 'Done' }).click();
  const one = tray.locator('li').first();
  await expect(one).toHaveAttribute('aria-label', 'one.png, marked: Ready');
  await expect(one.locator('.tray-badge')).toHaveText('');
  await page.getByRole('button', { name: 'Remove one.png' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove the marked picture?' });
  await expect(confirm).toContainText('Your marks on one.png go with it.');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(tray.locator('li')).toHaveCount(1);

  // An unmarked picture is removed without asking. First: the marked picture's upload fails, then retries.
  await request.post('/test/upload-fail', { data: { status: 500 } });
  ({ cover, canvas } = await openCover(page, 'two.png'));
  await cover.getByRole('group', { name: 'Tool' }).getByRole('button', { name: 'Comment' }).click();
  await tap(canvas, 200, 300);
  await write(page, 'Comment 1', 'here');
  await cover.getByRole('button', { name: 'Done' }).click();
  const two = tray.locator('li');
  await expect(two).toHaveAttribute('data-state', 'failed');
  await expect(two.getByRole('alert')).toContainText('Upload failed: the host answered 500.');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await two.getByRole('button', { name: 'Retry' }).click();
  await expect(two).toHaveAttribute('data-state', 'ready');
  const stored = await uploads(request);
  expect(stored.at(-1)).toMatchObject({ name: 'two.png', width: 600, height: 600 });
  await page.getByRole('button', { name: 'Send' }).click();
  const params = ((await (await request.post('/test/last', { data: { method: 'turn/start' } })).json()) as { params: { input: Record<string, string>[] } }).params;
  expect(params.input).toEqual([
    { type: 'text', text: expect.stringMatching(/^Marks on the attached image \(the numbers match the pins\):\n1\. here \(at \d+% across, \d+% down\)$/) },
    { type: 'image', url: `/v1/blob/${stored.at(-1)!.blobId}` },
  ]);
});

test('a pin near the bottom is lifted above the comment sheet while it is open, and goes back after', async ({ page, request }) => {
  await openSession(page, request);
  await page.locator('input.composer-file').setInputFiles([{ name: 'tall.png', mimeType: 'image/png', buffer: await screenshotPng(page, 1000, 2000) }]);
  await expect(page.getByRole('list', { name: 'Attachments to send' }).locator('li')).toHaveAttribute('data-state', 'ready');
  const { cover, canvas } = await openCover(page, 'tall.png');
  await cover.getByRole('group', { name: 'Tool' }).getByRole('button', { name: 'Comment' }).click();
  const box = (await canvas.boundingBox())!;
  const x = Math.round(box.width / 2);
  const y = Math.round(box.height - 30);
  /** The lowest red pixel (the pin) in the canvas's column at x, in CSS px from the canvas's top. */
  const lowestRed = () =>
    canvas.evaluate((el: HTMLCanvasElement, column) => {
      const ratio = el.width / el.clientWidth;
      const data = el.getContext('2d')!.getImageData(Math.round(column * ratio), 0, 1, el.height).data;
      let lowest = -1;
      for (let row = 0; row < el.height; row++) if (data[row * 4]! > 200 && data[row * 4 + 1]! < 120) lowest = row;
      return lowest / ratio;
    }, x);
  await tap(canvas, x, y);
  const sheet = page.getByRole('dialog', { name: 'Comment 1' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(600); // the sheet has risen
  const sheetTop = (await sheet.boundingBox())!.y - box.y;
  await expect.poll(lowestRed).toBeLessThan(sheetTop);
  await expect.poll(lowestRed).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/light-6-pin-lifted.png` });
  await write(page, 'Comment 1', 'bottom edge');
  // Back where it was: the pin sits where the finger tapped.
  await expect.poll(lowestRed).toBeGreaterThan(y);
});
