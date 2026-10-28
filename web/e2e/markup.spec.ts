import { mkdirSync } from 'node:fs';

import { expect, test, type Locator, type Page } from './worker-host';

// The lab's Markup scene (docs/plan/image-markup.md, ticket 2): the markup cover on the bundled screenshot.
// Touches are dispatched as pointer events on the canvas (pointerType touch, one pointerId per finger), the
// way iOS Safari delivers them; positions are relative to the canvas's top-left corner. Screenshots go to
// /tmp/brocode-xu4.2-shots/ (not the repo).

const SHOTS = '/tmp/brocode-xu4.2-shots';
mkdirSync(SHOTS, { recursive: true });

type Touch = [id: number, x: number, y: number];

/** Dispatches pointer events on the canvas: one entry per event, `type` and the finger at (x, y). */
async function pointers(canvas: Locator, events: [type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', ...Touch][]): Promise<void> {
  await canvas.evaluate((el, list) => {
    const rect = el.getBoundingClientRect();
    for (const [type, id, x, y] of list) {
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: type === 'pointermove' ? -1 : 0 }));
    }
  }, events);
}

/** One finger from `from` to `to` in `steps` moves. */
async function stroke(canvas: Locator, from: [number, number], to: [number, number], steps = 8, id = 1): Promise<void> {
  const moves: [('pointermove'), ...Touch][] = [];
  for (let i = 1; i <= steps; i++) moves.push(['pointermove', id, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);
  await pointers(canvas, [['pointerdown', id, ...from], ...moves, ['pointerup', id, ...to]]);
}

async function openMarkup(page: Page): Promise<{ cover: Locator; canvas: Locator }> {
  await page.goto('/lab');
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Lab' });
  await panel.getByRole('group', { name: 'Markup' }).getByRole('button', { name: 'Open' }).click();
  const cover = page.getByRole('dialog', { name: 'Mark up' });
  await expect(cover).toBeVisible();
  const canvas = cover.locator('canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, no marks');
  await page.waitForTimeout(700); // the rise has settled
  return { cover, canvas };
}

for (const scheme of ['light', 'dark'] as const) {
  test(`markup (${scheme}): every tool and colour draws; undo, redo and clear; Done reports the marks`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { cover, canvas } = await openMarkup(page);
    await page.screenshot({ path: `${SHOTS}/markup-${scheme}-open.png` });

    const tools = cover.getByRole('group', { name: 'Tool' });
    const colours = cover.getByRole('group', { name: 'Colour' });
    await expect(tools.getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true');
    await expect(colours.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'true');
    await expect(cover.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(cover.getByRole('button', { name: 'Clear all marks' })).toBeDisabled();

    await stroke(canvas, [80, 120], [200, 160]);
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 mark');

    // the highlighter defaults to yellow; a colour picked for a tool stays with that tool
    await tools.getByRole('button', { name: 'Highlighter' }).click();
    await expect(colours.getByRole('button', { name: 'Yellow' })).toHaveAttribute('aria-pressed', 'true');
    await stroke(canvas, [60, 250], [260, 250]);
    await tools.getByRole('button', { name: 'Rectangle' }).click();
    await colours.getByRole('button', { name: 'Blue' }).click();
    await stroke(canvas, [50, 330], [300, 420]);
    await tools.getByRole('button', { name: 'Arrow' }).click();
    await expect(colours.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'true');
    await colours.getByRole('button', { name: 'Green' }).click();
    await stroke(canvas, [300, 520], [180, 440]);
    await tools.getByRole('button', { name: 'Rectangle' }).click();
    await expect(colours.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 4 marks');
    await page.screenshot({ path: `${SHOTS}/markup-${scheme}-marks.png` });

    await cover.getByRole('button', { name: 'Undo' }).click();
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 3 marks');
    await cover.getByRole('button', { name: 'Redo' }).click();
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 4 marks');
    await expect(cover.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await cover.getByRole('button', { name: 'Clear all marks' }).click();
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, no marks');
    await cover.getByRole('button', { name: 'Undo' }).click(); // clear is undoable
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 4 marks');

    await cover.getByRole('button', { name: 'Done' }).click();
    await expect(cover).toBeHidden();
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Markup' })).toContainText('Done with 4 marks.');
  });
}

test('markup: a touch under the stroke-start threshold draws nothing; two fingers never draw; double tap fits again', async ({ page }) => {
  const { cover, canvas } = await openMarkup(page);
  const fitted = await canvas.screenshot();

  // a tap, and a 4 px wobble, are not strokes
  await stroke(canvas, [150, 200], [150, 200], 1);
  await stroke(canvas, [150, 200], [153, 202], 3);
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, no marks');

  // a second finger before the threshold pinches: the picture zooms, no mark
  await pointers(canvas, [
    ['pointerdown', 1, 150, 300],
    ['pointermove', 1, 151, 301],
    ['pointerdown', 2, 230, 300],
    ['pointermove', 2, 260, 300],
    ['pointermove', 1, 100, 300],
    ['pointermove', 2, 300, 320],
    ['pointerup', 2, 300, 320],
    // the finger left on the glass does nothing until it lifts
    ['pointermove', 1, 20, 400],
    ['pointerup', 1, 20, 400],
  ]);
  await page.waitForTimeout(100);
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, no marks');
  const zoomed = await canvas.screenshot();
  expect(zoomed.equals(fitted)).toBe(false);

  // a second finger mid-stroke drops the stroke and pinches
  await pointers(canvas, [
    ['pointerdown', 1, 100, 200],
    ['pointermove', 1, 140, 200],
    ['pointermove', 1, 180, 200],
    ['pointerdown', 2, 250, 260],
    ['pointermove', 2, 230, 240],
    ['pointerup', 1, 180, 200],
    ['pointerup', 2, 230, 240],
  ]);
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, no marks');

  // double tap: back to the fitted picture
  await stroke(canvas, [200, 300], [200, 300], 1);
  await stroke(canvas, [202, 302], [202, 302], 1);
  await page.waitForTimeout(500);
  await expect.poll(async () => (await canvas.screenshot()).equals(fitted)).toBe(true);

  // the cover and the canvas take every touch: no page scroll, zoom or double-tap zoom under them
  expect(await cover.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect(await canvas.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');

  await cover.getByRole('button', { name: 'Cancel' }).click();
  await expect(cover).toBeHidden();
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Markup' })).toContainText('Cancelled.');
});

test('markup: the canvas renders at device pixel ratio; Escape cancels', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const { cover, canvas } = await openMarkup(page);
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height, cw: el.clientWidth, ch: el.clientHeight }));
  expect(size.w).toBe(size.cw * 3);
  expect(size.h).toBe(Math.round(size.ch * 3));
  await page.keyboard.press('Escape');
  await expect(cover).toBeHidden();
  await context.close();
});

test('markup: with Reduce Motion the cover cross-fades instead of rising', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/lab');
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('group', { name: 'Markup' }).getByRole('button', { name: 'Open' }).click();
  const cover = page.getByRole('dialog', { name: 'Mark up' });
  await expect(cover).toBeVisible();
  const keyframes = await cover.evaluate((el) => el.getAnimations().map((a) => (a.effect as KeyframeEffect).getKeyframes().map((k) => Object.keys(k).filter((key) => key === 'opacity' || key === 'transform'))));
  expect(keyframes.length).toBeGreaterThan(0);
  for (const frames of keyframes) for (const props of frames) expect(props).toEqual(['opacity']);
});

test('markup: the cover sits above the page stack, so a stroke from the left edge never swipes back', async ({ page }) => {
  await page.goto('/lab');
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Lab' });
  await panel.getByRole('group', { name: 'Page push and back swipe' }).getByRole('button', { name: 'Smooth' }).click();
  await panel.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('list', { name: 'Sessions' }).getByRole('link').first().click();
  await expect(page.locator('.lab-session-page')).toBeVisible();

  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('group', { name: 'Markup' }).getByRole('button', { name: 'Open' }).click();
  const cover = page.getByRole('dialog', { name: 'Mark up' });
  const canvas = cover.locator('canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  // the lab's back swipe listens to touch events; send both kinds from the very left edge
  const point = (x: number, y: number) => [{ identifier: 1, clientX: x, clientY: y }];
  await canvas.dispatchEvent('touchstart', { touches: point(2, 300), changedTouches: point(2, 300) });
  for (let x = 20; x <= 300; x += 40) await canvas.dispatchEvent('touchmove', { touches: point(x, 300), changedTouches: point(x, 300) });
  await canvas.dispatchEvent('touchend', { touches: [], changedTouches: point(300, 300) });
  await stroke(canvas, [2, 300], [300, 300]);
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 mark');
  await cover.getByRole('button', { name: 'Cancel' }).click();
  await expect(cover).toBeHidden();
  await expect(page.locator('.lab-session-page')).toBeVisible();
  await expect(page.locator('.lab-session-page')).toHaveCSS('transform', 'none');
});
