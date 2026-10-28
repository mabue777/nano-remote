import { mkdirSync } from 'node:fs';

import { expect, test, type Locator, type Page } from './worker-host';

// Comments on marks (docs/plan/image-markup.md, ticket 3), in the lab's Markup scene: the comment tool's
// numbered pins, the comment sheet (Save, Delete, Cancel), a tap on a mark, renumbering after a delete, the
// hidden list VoiceOver reads, the composed text and the badge's count; and Cancel asking before it discards.
// Touches are pointer events on the canvas (pointerType touch), positions from the canvas's top-left corner.
// Screenshots go to /tmp/brocode-xu4.3-shots/ (not the repo).

const SHOTS = '/tmp/brocode-xu4.3-shots';
mkdirSync(SHOTS, { recursive: true });

type Touch = [id: number, x: number, y: number];
type Kind = 'pointerdown' | 'pointermove' | 'pointerup';

async function pointers(canvas: Locator, events: [type: Kind, ...Touch][]): Promise<void> {
  await canvas.evaluate((el, list) => {
    const rect = el.getBoundingClientRect();
    for (const [type, id, x, y] of list) {
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: type === 'pointermove' ? -1 : 0 }));
    }
  }, events);
}

async function tap(canvas: Locator, x: number, y: number): Promise<void> {
  await pointers(canvas, [
    ['pointerdown', 1, x, y],
    ['pointerup', 1, x, y],
  ]);
}

async function drag(canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const moves: [Kind, ...Touch][] = [];
  for (let i = 1; i <= 8; i++) moves.push(['pointermove', 1, from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8]);
  await pointers(canvas, [['pointerdown', 1, ...from], ...moves, ['pointerup', 1, ...to]]);
}

async function openMarkup(page: Page): Promise<{ cover: Locator; canvas: Locator }> {
  await page.goto('/lab');
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('dialog', { name: 'Lab' }).getByRole('group', { name: 'Markup' }).getByRole('button', { name: 'Open' }).click();
  const cover = page.getByRole('dialog', { name: 'Mark up' });
  const canvas = cover.locator('canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(700); // the rise has settled
  return { cover, canvas };
}

/** Writes `text` into the open comment sheet and saves it (Enter or the Save button). */
async function write(page: Page, title: string, text: string, how: 'enter' | 'save' = 'save'): Promise<void> {
  const sheet = page.getByRole('dialog', { name: title });
  await expect(sheet).toBeVisible();
  const field = sheet.getByRole('textbox', { name: title });
  await expect(field).toBeFocused();
  await field.fill(text);
  if (how === 'enter') await field.press('Enter');
  else await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`comments (${scheme}): three added, one edited, one deleted; the rest read 1 and 2 on screen, to VoiceOver and in the text`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { cover, canvas } = await openMarkup(page);
    const tools = cover.getByRole('group', { name: 'Tool' });
    const pins = cover.getByRole('list', { name: 'Comments' }).getByRole('button');

    // the comment tool: a tap places pin 1 and opens the sheet; the colours are off (pins are red)
    await tools.getByRole('button', { name: 'Comment' }).click();
    await expect(cover.getByRole('group', { name: 'Colour' }).getByRole('button', { name: 'Blue' })).toBeDisabled();
    await tap(canvas, 90, 140);
    const first = page.getByRole('dialog', { name: 'Comment 1' });
    await expect(first.getByRole('button', { name: 'Delete' })).toHaveCount(0); // a new pin has nothing to delete
    await expect(first.getByRole('button', { name: 'Save' })).toBeDisabled(); // nothing written yet
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/comments-${scheme}-sheet.png` });
    await write(page, 'Comment 1', 'this button is misaligned');
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 comment');

    await tap(canvas, 220, 320);
    await write(page, 'Comment 2', 'wrong colour here', 'enter');

    // a tap on a mark, with a drawing tool, comments on the mark
    await tools.getByRole('button', { name: 'Rectangle' }).click();
    await drag(canvas, [60, 420], [260, 520]);
    await tap(canvas, 160, 470);
    await write(page, 'Comment 3', 'too much padding');
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 mark, 3 comments');
    await expect(pins).toHaveText(['Comment 1: this button is misaligned', 'Comment 2: wrong colour here', 'Comment 3: too much padding']);
    await page.screenshot({ path: `${SHOTS}/comments-${scheme}-three.png` });

    // a tap on pin 2, with any tool, edits it; Cancel on a new pin keeps nothing
    await tools.getByRole('button', { name: 'Pen' }).click();
    await tap(canvas, 222, 318);
    await expect(page.getByRole('dialog', { name: 'Comment 2' }).getByRole('textbox')).toHaveValue('wrong colour here');
    await write(page, 'Comment 2', 'wrong colour, should be grey');
    await tools.getByRole('button', { name: 'Comment' }).click();
    await tap(canvas, 300, 600);
    await page.getByRole('dialog', { name: 'Comment 4' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: 'Comment 4' })).toBeHidden();
    await expect(pins).toHaveCount(3);

    // VoiceOver's way in: the hidden list's button opens pin 1, which is deleted; the others renumber
    await pins.first().focus(); // a 1 px hidden button: activated the way VoiceOver and a keyboard do
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Comment 1' }).getByRole('button', { name: 'Delete' }).click();
    await expect(pins).toHaveText(['Comment 1: wrong colour, should be grey', 'Comment 2: too much padding']);
    await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 mark, 2 comments');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/comments-${scheme}-renumbered.png` });

    // undo brings the deleted comment back as 1
    await cover.getByRole('button', { name: 'Undo' }).click();
    await expect(pins).toHaveCount(3);
    await expect(pins.first()).toHaveText('Comment 1: this button is misaligned');
    await cover.getByRole('button', { name: 'Redo' }).click();
    await expect(pins).toHaveCount(2);

    await cover.getByRole('button', { name: 'Done' }).click();
    await expect(cover).toBeHidden();
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    const row = page.getByRole('group', { name: 'Markup' });
    await expect(row).toContainText('Done with 1 mark and 2 comments.');
    await expect(row.getByRole('img', { name: 'Marked, 2 comments' })).toBeVisible();
    const lines = await row.getByLabel('Text sent with the picture').innerText();
    expect(lines.split('\n')).toEqual([
      'Marks on the attached image (the numbers match the pins):',
      expect.stringMatching(/^1\. wrong colour, should be grey \(at \d+% across, \d+% down\)$/),
      expect.stringMatching(/^2\. too much padding \(around \d+-\d+% across, \d+-\d+% down\)$/),
    ]);
    await page.screenshot({ path: `${SHOTS}/comments-${scheme}-result.png` });
  });
}

test('comments: a pin keeps its screen size while zoomed in', async ({ page }) => {
  const { cover, canvas } = await openMarkup(page);
  await cover.getByRole('group', { name: 'Tool' }).getByRole('button', { name: 'Comment' }).click();
  await tap(canvas, 195, 300);
  await write(page, 'Comment 1', 'here');
  const red = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      // the pin's red pixels in a 120 px box around the canvas centre (where the pin is), CSS px squared
      const ctx = el.getContext('2d')!;
      const d = el.width / el.clientWidth;
      const size = Math.round(120 * d);
      const { data } = ctx.getImageData(Math.round(195 * d - size / 2), Math.round(300 * d - size / 2), size, size);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! > 230 && data[i + 1]! < 90 && data[i + 2]! < 80) n++;
      return n / (d * d);
    });
  const fitted = await red();
  expect(fitted).toBeGreaterThan(200);
  // pinch out around the pin: the picture grows, the pin does not
  await pointers(canvas, [
    ['pointerdown', 1, 175, 300],
    ['pointerdown', 2, 215, 300],
    ['pointermove', 1, 115, 300],
    ['pointermove', 2, 275, 300],
    ['pointerup', 1, 115, 300],
    ['pointerup', 2, 275, 300],
  ]);
  await page.waitForTimeout(100);
  const zoomed = await red();
  expect(Math.abs(zoomed - fitted) / fitted).toBeLessThan(0.15);
  await page.screenshot({ path: `${SHOTS}/comments-zoomed.png` });
});

test('cancel asks before it discards marks; Keep editing keeps them; with no marks it just closes', async ({ page }) => {
  const { cover, canvas } = await openMarkup(page);
  await cover.getByRole('button', { name: 'Cancel' }).click(); // nothing drawn: no question
  await expect(cover).toBeHidden();

  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('group', { name: 'Markup' }).getByRole('button', { name: 'Open' }).click();
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(700);
  await drag(canvas, [80, 120], [200, 160]);
  await cover.getByRole('button', { name: 'Cancel' }).click();
  const ask = page.getByRole('dialog', { name: 'Discard your marks?' });
  await expect(ask).toContainText('The 1 mark on this picture will be lost.');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/discard-confirm.png` });
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(ask).toBeHidden();
  await expect(canvas).toHaveAttribute('aria-label', 'Screenshot, 1 mark');

  await page.keyboard.press('Escape'); // Escape asks too
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(cover).toBeHidden();
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Markup' })).toContainText('Cancelled.');
});
