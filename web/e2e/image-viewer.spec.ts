import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from './worker-host';

// The in-app image viewer (docs/plan/file-viewer.md P1, ui/ImageViewer.tsx) against the fake host at 390 x 844,
// light and dark: a sent photo opens in a black layer that grows out of its thumbnail (no new tab), "2 of 3",
// swipes between the message's photos, double tap and pinch zoom (real touches through CDP, so the layer's
// touch-action: none and the pointer events are what a phone sends), a swipe down shrinks it back. Share hands
// a file to navigator.share or says to touch and hold; a failed load offers Try again; the tray's photos open
// too; Reduce Motion only cross-fades. The no-layout-shift check measures the thumbnail's and the viewer's
// boxes between first paint and load. Screenshots go to /tmp/brocode-rvc.1-shots/.

const SHOTS = '/tmp/brocode-rvc.1-shots';
const SESSION = 'ses_fake_3'; // a Codex session with no turns yet
const VIEWER = '.iv';

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

/** A PNG of width x height drawn in the page: a gradient with a label, so each picture looks different. */
async function pngOf(page: Page, width: number, height: number, label: string, from = '#2f5bd3', to = '#f6c445'): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h, text, a, b]) => {
      const canvas = document.createElement('canvas');
      canvas.width = Number(w);
      canvas.height = Number(h);
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, Number(w), Number(h));
      gradient.addColorStop(0, String(a));
      gradient.addColorStop(1, String(b));
      context.fillStyle = gradient;
      context.fillRect(0, 0, Number(w), Number(h));
      context.fillStyle = '#ffffff';
      context.font = `${Math.round(Number(h) / 4)}px sans-serif`;
      context.fillText(String(text), Number(w) / 10, Number(h) / 2);
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    [width, height, label, from, to] as const,
  );
  return Buffer.from(base64, 'base64');
}

/** Picks three photos (2:1, 1:2, 4:3) and sends them; returns the message's thumbnails. */
async function sendThree(page: Page): Promise<Locator> {
  await page.locator('input.composer-file').setInputFiles([
    { name: 'wide.png', mimeType: 'image/png', buffer: await pngOf(page, 1600, 800, 'One') },
    { name: 'tall.png', mimeType: 'image/png', buffer: await pngOf(page, 600, 1200, 'Two', '#1f8a4c', '#f2efe6') },
    { name: 'photo.png', mimeType: 'image/png', buffer: await pngOf(page, 1200, 900, 'Three', '#8a1f6b', '#f6c445') },
  ]);
  await expect(page.getByRole('list', { name: 'Attachments to send' }).locator('li[data-state="ready"]')).toHaveCount(3);
  await page.getByRole('textbox', { name: 'Message' }).fill('Three sketches of the header.');
  await page.getByRole('button', { name: 'Send' }).click();
  const thumbs = page.locator('[data-item="user"]').first().getByRole('list', { name: 'Attached images' });
  for (let i = 1; i <= 3; i++) {
    const img = thumbs.getByRole('img', { name: `Attached image ${i}` });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  }
  return thumbs;
}

const viewerImage = (page: Page, index: number) => page.locator(`${VIEWER} .iv-slide[data-index="${index}"] .iv-image`);

/** Waits until nothing animates in the viewer any more. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector(sel)?.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length ?? 0, VIEWER), {
      intervals: [50],
    })
    .toBe(0);
}

/** The scale and translation of a viewer picture's transform. */
async function zoomOf(image: Locator): Promise<{ scale: number; x: number; y: number }> {
  return image.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
    return { scale: m.a, x: m.e, y: m.f };
  });
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
  });
}

// Real touches (Chromium's touch emulation turns them into pointer events, as Safari does).
type TouchPoint = { x: number; y: number; id?: number };

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: TouchPoint[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
}

/** A one-finger drag; `pauseMs` between moves makes it slow (no flick), as a finger that eases off. */
async function swipe(cdp: CDPSession, from: TouchPoint, to: TouchPoint, steps = 8, pauseMs = 0): Promise<void> {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  await touch(cdp, 'touchEnd', []);
}

async function doubleTap(cdp: CDPSession, at: TouchPoint): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await touch(cdp, 'touchStart', [at]);
    await touch(cdp, 'touchEnd', []);
  }
}

async function pinch(cdp: CDPSession, center: TouchPoint, from: number, to: number, steps = 8): Promise<void> {
  const at = (d: number) => [
    { x: center.x - d / 2, y: center.y, id: 0 },
    { x: center.x + d / 2, y: center.y, id: 1 },
  ];
  await touch(cdp, 'touchStart', at(from));
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', at(from + ((to - from) * i) / steps));
  await touch(cdp, 'touchEnd', []);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a sent photo opens in the viewer: grow, 2 of 3, swipe, zoom, swipe down (${scheme})`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openSession(page, request);
    const thumbs = await sendThree(page);
    await page.screenshot({ path: `${SHOTS}/${scheme}-1-thumbnails.png` });
    // The thumbnail is a button now, not a link to a new tab.
    await expect(thumbs.getByRole('link')).toHaveCount(0);
    const pagesBefore = page.context().pages().length;

    // The first frame of the grow already shows the decoded picture, sitting on the thumbnail. The grow is
    // held at its start while it is measured (so a busy machine's skipped frames do not move it), then let go.
    const first = page.evaluate(
      () =>
        new Promise<{ loaded: string | null; natural: number; dx: number; dy: number; clip: string }>((resolve) => {
          const look = () => {
            const img = document.querySelector<HTMLImageElement>('.iv .iv-slide[data-index="1"] .iv-image');
            const grow = img?.getAnimations() ?? [];
            if (img === null || grow.length === 0) return void requestAnimationFrame(look);
            for (const animation of grow) {
              animation.pause();
              animation.currentTime = 0;
            }
            const r = img.getBoundingClientRect();
            const t = document.querySelector('[aria-label="Attached images"] li:nth-child(2) img')!.getBoundingClientRect();
            resolve({
              loaded: img.dataset.loaded ?? null,
              natural: img.naturalWidth,
              dx: r.left + r.width / 2 - (t.left + t.width / 2),
              dy: r.top + r.height / 2 - (t.top + t.height / 2),
              clip: getComputedStyle(img).clipPath,
            });
            for (const animation of grow) animation.play();
          };
          look();
        }),
    );
    await thumbs.getByRole('button', { name: 'Attached image 2' }).click();
    const frame = await first;
    expect(frame.loaded).toBe('true');
    expect(frame.natural).toBe(600);
    expect(frame.clip).toMatch(/^inset/);
    expect(Math.abs(frame.dx)).toBeLessThan(1);
    expect(Math.abs(frame.dy)).toBeLessThan(1);

    const viewer = page.getByRole('dialog', { name: 'Image 2 of 3' });
    await expect(viewer).toBeVisible();
    expect(page.context().pages().length).toBe(pagesBefore);
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('2 of 3');
    await expect(viewer.getByRole('button', { name: 'Close' })).toBeFocused();
    await settled(page);

    // Black in both schemes; its own touch handling; the app's no-zoom rule untouched.
    expect(await page.locator(`${VIEWER} .iv-backdrop`).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    expect(await page.locator(VIEWER).evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');

    // At rest the 1:2 picture (600 x 1200) fits the width, centred, unzoomed.
    expect(await box(viewerImage(page, 1))).toEqual({ x: 0, y: 32, width: 390, height: 780 });
    await page.screenshot({ path: `${SHOTS}/${scheme}-2-viewer-2-of-3.png` });

    const cdp = await page.context().newCDPSession(page);
    // Swipe left: the third picture.
    await swipe(cdp, { x: 320, y: 420 }, { x: 60, y: 420 });
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('3 of 3');
    await settled(page);
    await page.screenshot({ path: `${SHOTS}/${scheme}-3-swiped-3-of-3.png` });
    // Past the last one it springs back.
    await swipe(cdp, { x: 320, y: 420 }, { x: 60, y: 420 });
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('3 of 3');
    // Swipe right twice: the first.
    await swipe(cdp, { x: 60, y: 420 }, { x: 320, y: 420 });
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('2 of 3');
    await swipe(cdp, { x: 60, y: 420 }, { x: 320, y: 420 });
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('1 of 3');
    await settled(page);

    // Double tap zooms to 2.5x about the tap; again goes back to fit.
    const wide = viewerImage(page, 0);
    await doubleTap(cdp, { x: 195, y: 422 });
    await settled(page);
    expect((await zoomOf(wide)).scale).toBeCloseTo(2.5, 2);
    await page.screenshot({ path: `${SHOTS}/${scheme}-4-double-tap-zoom.png` });
    // A zoomed picture pans with one finger instead of swiping to the next.
    await swipe(cdp, { x: 300, y: 422 }, { x: 200, y: 422 });
    await settled(page);
    await expect(page.locator(`${VIEWER} .iv-count`)).toHaveText('1 of 3');
    await doubleTap(cdp, { x: 195, y: 422 });
    await settled(page);
    expect((await zoomOf(wide)).scale).toBeCloseTo(1, 2);

    // Pinch out; it stops at 4x however far the fingers go.
    await pinch(cdp, { x: 195, y: 422 }, 80, 240);
    await settled(page);
    const pinched = (await zoomOf(wide)).scale;
    expect(pinched).toBeGreaterThan(2.5);
    expect(pinched).toBeLessThanOrEqual(4);
    await pinch(cdp, { x: 195, y: 422 }, 60, 360);
    await settled(page);
    expect((await zoomOf(wide)).scale).toBeCloseTo(4, 2);
    await page.screenshot({ path: `${SHOTS}/${scheme}-5-pinched-4x.png` });
    // Pinch in past fit springs back to fit.
    await pinch(cdp, { x: 195, y: 422 }, 300, 20);
    await settled(page);
    expect((await zoomOf(wide)).scale).toBeCloseTo(1, 2);

    // A single tap hides the buttons; another shows them again.
    await touch(cdp, 'touchStart', [{ x: 195, y: 600 }]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator(`${VIEWER} .iv-bar`)).toBeHidden();
    await touch(cdp, 'touchStart', [{ x: 195, y: 600 }]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator(`${VIEWER} .iv-bar`)).toBeVisible();

    // A short drag down springs back; a long one shrinks the picture into its thumbnail.
    await swipe(cdp, { x: 195, y: 400 }, { x: 195, y: 440 }, 4, 60);
    await settled(page);
    await expect(page.getByRole('dialog', { name: 'Image 1 of 3' })).toBeVisible();
    await swipe(cdp, { x: 195, y: 300 }, { x: 205, y: 640 }, 10);
    await expect(page.locator(VIEWER)).toHaveCount(0);
    const firstThumb = thumbs.getByRole('img', { name: 'Attached image 1' });
    await expect(firstThumb).toBeVisible();
    expect(await firstThumb.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    await expect(thumbs.getByRole('button', { name: 'Attached image 1' })).toBeFocused();
  });
}

test('Close and Escape close it; Share hands the file over or says to touch and hold', async ({ page, request }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { shared: { name: string; type: string; size: number }[]; shareMode: 'ok' | 'none' };
    w.shared = [];
    w.shareMode = 'ok';
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => w.shareMode === 'ok' });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[] }) => {
        for (const file of data.files) w.shared.push({ name: file.name, type: file.type, size: file.size });
      },
    });
  });
  await openSession(page, request);
  const thumbs = await sendThree(page);

  await thumbs.getByRole('button', { name: 'Attached image 3' }).click();
  const viewer = page.getByRole('dialog', { name: 'Image 3 of 3' });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Share' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared)).toEqual([{ name: 'image-3.png', type: 'image/png', size: expect.any(Number) }]);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator(VIEWER)).toHaveCount(0);
  await expect(thumbs.getByRole('button', { name: 'Attached image 3' })).toBeFocused();

  // Where the system sheet cannot take the file: the touch-and-hold hint.
  await page.evaluate(() => ((window as unknown as { shareMode: string }).shareMode = 'none'));
  await thumbs.getByRole('button', { name: 'Attached image 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Image 1 of 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator(`${VIEWER} [role="status"]`)).toHaveText('Touch and hold the image to save it.');
  // The picture keeps Safari's long-press menu (Save to Photos).
  expect(await viewerImage(page, 0).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-touch-callout') || 'default')).toBe('default');
  await settled(page);
  await page.screenshot({ path: `${SHOTS}/light-6-share-fallback.png` });
  await page.keyboard.press('Escape');
  await expect(page.locator(VIEWER)).toHaveCount(0);
});

test('no layout shift: the thumbnail and the viewer keep their boxes from first paint to load', async ({ page, request }) => {
  await openSession(page, request);
  // Every picture answers late, so first paint and load are far apart.
  let delay = 0;
  await page.route('**/v1/blob/blb_*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await route.continue();
  });
  await page.locator('input.composer-file').setInputFiles([{ name: 'wide.png', mimeType: 'image/png', buffer: await pngOf(page, 1600, 800, 'Late') }]);
  await expect(page.getByRole('list', { name: 'Attachments to send' }).locator('li[data-state="ready"]')).toHaveCount(1);
  delay = 3000;
  await page.getByRole('button', { name: 'Send' }).click();
  const img = page.locator('[data-item="user"]').first().getByRole('img', { name: 'Attached image 1' });
  await expect(img).toBeVisible();
  // First paint, after the message has risen out of the composer (its own motion), before the bytes arrive.
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length))
    .toBe(0);
  const beforeThumb = await box(img);
  const messageBefore = await box(page.locator('[data-item="user"]').first());
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(false);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBe(1600);
  expect(await box(img)).toEqual(beforeThumb);
  expect(await box(page.locator('[data-item="user"]').first())).toEqual(messageBefore);

  // The viewer: the picture's box at the end of the grow is the box after a fresh load completes.
  await page.getByRole('button', { name: 'Attached image 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
  await settled(page);
  const opened = await box(viewerImage(page, 0));
  expect(opened).toEqual({ x: 0, y: 324.5, width: 390, height: 195 });
  await page.waitForTimeout(1500);
  expect(await box(viewerImage(page, 0))).toEqual(opened);
  await page.keyboard.press('Escape');
  await expect(page.locator(VIEWER)).toHaveCount(0);
});

test('a picture that does not load says so and tries again', async ({ page, request }) => {
  await openSession(page, request);
  await sendThree(page);
  // A fresh page: every picture now fails until the route is lifted.
  await page.route('**/v1/blob/blb_*', (route) => route.abort());
  await page.reload();
  const thumbs = page.locator('[data-item="user"]').first().getByRole('list', { name: 'Attached images' });
  await thumbs.getByRole('button', { name: 'Attached image 2' }).click();
  const viewer = page.getByRole('dialog', { name: 'Image 2 of 3' });
  await expect(viewer).toBeVisible();
  const slide = page.locator(`${VIEWER} .iv-slide[data-index="1"]`);
  await expect(slide.getByRole('alert')).toContainText("Couldn't load this image");
  await page.screenshot({ path: `${SHOTS}/light-7-load-failed.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/dark-7-load-failed.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.unroute('**/v1/blob/blb_*');
  await slide.getByRole('button', { name: 'Try again' }).click();
  await expect(slide.getByRole('alert')).toHaveCount(0);
  await expect(viewerImage(page, 1)).toHaveAttribute('data-loaded', 'true');
  expect(await box(viewerImage(page, 1))).toEqual({ x: 0, y: 32, width: 390, height: 780 });
});

test('a photo in the composer tray opens in the viewer too', async ({ page, request }) => {
  await openSession(page, request);
  await page.locator('input.composer-file').setInputFiles([
    { name: 'whiteboard.png', mimeType: 'image/png', buffer: await pngOf(page, 1200, 900, 'Tray') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\n') },
  ]);
  const tray = page.getByRole('list', { name: 'Attachments to send' });
  await expect(tray.locator('li[data-state="ready"]')).toHaveCount(2);
  // No border on the tile any more (look rules: no borders).
  expect(await tray.locator('img.tray-thumb').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  await page.screenshot({ path: `${SHOTS}/light-8-tray.png` });
  await tray.getByRole('button', { name: 'whiteboard.png', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Image' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'whiteboard.png' })).toBeVisible();
  await expect(page.locator(`${VIEWER} .iv-count`)).toHaveCount(0);
  await settled(page);
  await page.screenshot({ path: `${SHOTS}/light-9-tray-viewer.png` });
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator(VIEWER)).toHaveCount(0);
  await expect(tray.locator('li')).toHaveCount(2);
});

test('Reduce Motion: the viewer cross-fades, nothing grows or shrinks', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const w = window as unknown as { animated: string[] };
    w.animated = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (this.closest('.iv') !== null && Array.isArray(keyframes)) for (const key of Object.keys(keyframes[0] ?? {})) w.animated.push(key);
      return original.call(this, keyframes, options);
    };
  });
  await openSession(page, request);
  const thumbs = await sendThree(page);
  await thumbs.getByRole('button', { name: 'Attached image 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Image 1 of 3' })).toBeVisible();
  await settled(page);
  expect(await box(viewerImage(page, 0))).toEqual({ x: 0, y: 324.5, width: 390, height: 195 });
  await page.keyboard.press('Escape');
  await expect(page.locator(VIEWER)).toHaveCount(0);
  const animated = await page.evaluate(() => (window as unknown as { animated: string[] }).animated);
  expect(animated.length).toBeGreaterThan(0);
  expect(new Set(animated)).toEqual(new Set(['opacity']));
});
