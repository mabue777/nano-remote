import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { sheetsClosed, sheetsSettled } from './sheets';

// The interaction lab's motion adopted by the real app at 390 x 844 (docs/research/interaction-feel-prototype.md,
// techniques 1, 3 and 10): sheets spring up while the dim layer fades in, a drag down follows the finger and
// dismisses past 30% or springs back, every close slides the sheet out before it is gone; buttons and rows
// dim and shrink while pressed; Accept and Send play the haptic tick. With reduced motion nothing animates by
// itself. An init script records every Element.animate call and every haptic tick, so the checks do not
// race the animations. Screenshots of the sheet at rest, light and dark, go to the test's output folder.

interface Played {
  ghost: boolean;
  cls: string;
  keyframes: string;
  duration: unknown;
  easing: unknown;
}

declare global {
  interface Window {
    __played: Played[];
    __ticks: number;
  }
}

test.beforeEach(async ({ page, request }) => {
  await request.post('/test/reset');
  await page.addInitScript(() => {
    window.__played = [];
    window.__ticks = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      const timing = typeof options === 'object' ? options : { duration: options };
      window.__played.push({ ghost: this.closest('.sheet-ghost') !== null, cls: this.className, keyframes: JSON.stringify(keyframes), duration: timing.duration, easing: timing.easing });
      return animate.call(this, keyframes, options);
    };
    const click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function (this: HTMLElement) {
      if (this instanceof HTMLLabelElement && this.querySelector('input[type="checkbox"][switch]') !== null) window.__ticks += 1;
      click.call(this);
    };
  });
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

async function openNewSession(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  return sheet;
}

const played = (page: Page) => page.evaluate(() => window.__played);

/**
 * A one-finger touch drag dispatched as touch events (the sheet's drag listens to touch events), `paceMs` or
 * more between moves. The release speed is at most one step per `paceMs`: a slow drag that must spring back
 * keeps it under the 0.5 px/ms flick with small steps and a long pace.
 */
async function touchDrag(page: Page, target: Locator, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6, lift = true, paceMs = 8): Promise<void> {
  const point = (x: number, y: number) => [{ identifier: 1, clientX: x, clientY: y }];
  await target.dispatchEvent('touchstart', { touches: point(from.x, from.y), changedTouches: point(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await target.dispatchEvent('touchmove', { touches: point(x, y), changedTouches: point(x, y) });
    await page.waitForTimeout(paceMs); // the finger's pace: an upper bound on the release speed
  }
  if (lift) await target.dispatchEvent('touchend', { touches: [], changedTouches: point(to.x, to.y) });
}

const SLIDE_UP = JSON.stringify([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }]);
const FADE_IN = JSON.stringify([{ opacity: 0 }, { opacity: 1 }]);

test('a sheet springs up while the dim layer fades in; Cancel slides it out and it is gone after', async ({ page, request }) => {
  await pair(page, request);
  const sheet = await openNewSession(page);
  // The sheet spring (stiffness 380, damping 33) comes to rest after 471 ms.
  await expect.poll(() => played(page)).toContainEqual(expect.objectContaining({ ghost: false, cls: 'sheet', keyframes: SLIDE_UP, easing: expect.stringMatching(/^linear\(/), duration: 471 }));
  expect(await played(page)).toContainEqual(expect.objectContaining({ ghost: false, cls: 'sheet-scrim', keyframes: FADE_IN, duration: 200 }));

  await sheetsSettled(page);
  const rest = (await sheet.boundingBox())!;
  expect(rest.y + rest.height).toBeCloseTo(844, 0); // resting on the bottom edge
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: test.info().outputPath(`new-session-sheet-${scheme}-390.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0); // the dialog is closed at once
  const exit = (await played(page)).filter((p) => p.ghost);
  expect(exit).toEqual([
    expect.objectContaining({ cls: expect.stringContaining('sheet'), keyframes: JSON.stringify([{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }]), duration: 260 }),
    expect.objectContaining({ cls: 'sheet-scrim', keyframes: JSON.stringify([{ opacity: 1 }, { opacity: 0 }]), duration: 260 }),
  ]);
  await sheetsClosed(page); // and its copy has slid out
  await expect(page.locator('.sheet-ghost')).toHaveCount(0);
});

test('a tap on the dim layer closes with the slide-out; so does Escape and starting a session', async ({ page, request }) => {
  await pair(page, request);
  await openNewSession(page);
  await sheetsSettled(page);
  await page.mouse.click(195, 20); // above the panel: the dim layer
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await played(page)).filter((p) => p.ghost)).toHaveLength(2);
  await sheetsClosed(page);

  // Start session closes the sheet by navigating: it still slides out, over the session.
  const sheet = await openNewSession(page);
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsClosed(page);
  expect((await played(page)).filter((p) => p.ghost)).toHaveLength(4);

  // Escape (a hardware keyboard) on the session's settings sheet, opened from the ⋯ sheet's Model row (which
  // slides the ⋯ sheet out).
  await page.getByRole('button', { name: 'Session details' }).click();
  await sheetsSettled(page);
  await page.getByTitle('Change model and effort').click();
  await expect(page.getByRole('dialog', { name: 'Model and effort' })).toBeVisible();
  await sheetsSettled(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await sheetsClosed(page);
  expect((await played(page)).filter((p) => p.ghost)).toHaveLength(8);
});

test('a short drag down springs back; a long one dismisses; a drag on a field or in scrolled content leaves the sheet', async ({ page, request }) => {
  await pair(page, request);
  const sheet = await openNewSession(page);
  await sheetsSettled(page);
  const rest = (await sheet.boundingBox())!;

  // Short and slow: back to its place on the spring.
  await touchDrag(page, sheet, { x: 200, y: rest.y + 20 }, { x: 200, y: rest.y + 80 }, 10, true, 30); // 6 px per 30 ms or more
  await expect.poll(() => played(page)).toContainEqual(expect.objectContaining({ cls: 'sheet', keyframes: expect.stringMatching(/^\[\{"transform":"translateY\(\d+(\.\d+)?px\)"\},\{"transform":"translateY\(0\)"\}\]$/) }));
  await sheetsSettled(page);
  expect((await sheet.boundingBox())!.y).toBeCloseTo(rest.y, 0);

  // A drag that starts on a field is the field's: the sheet stays, and the field still takes text.
  const title = sheet.getByRole('textbox', { name: 'Title (optional)' });
  const field = (await title.boundingBox())!;
  await touchDrag(page, title, { x: field.x + 20, y: field.y + 10 }, { x: field.x + 20, y: field.y + 400 }, 6, false);
  expect(await sheet.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
  await title.dispatchEvent('touchend', { touches: [], changedTouches: [] });
  await title.fill('Keep the parser small');
  await expect(title).toHaveValue('Keep the parser small');

  // Scrolled content: a drag down scrolls it back instead of pulling the sheet.
  await sheet.evaluate((el) => {
    (el as HTMLElement).style.maxHeight = '300px';
    el.scrollTop = 120;
  });
  const short = (await sheet.boundingBox())!;
  await touchDrag(page, sheet, { x: 200, y: short.y + 40 }, { x: 200, y: short.y + 280 });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
  await sheet.evaluate((el) => {
    (el as HTMLElement).style.maxHeight = '';
    el.scrollTop = 0;
  });

  // Long: past 30% dismisses, and the sheet goes on sliding from where the finger left it.
  await touchDrag(page, sheet, { x: 200, y: rest.y + 20 }, { x: 200, y: rest.y + 20 + rest.height * 0.6 });
  await expect(sheet).toHaveCount(0);
  const exit = (await played(page)).filter((p) => p.ghost && p.cls.includes('sheet') && p.cls !== 'sheet-scrim');
  expect(exit).toHaveLength(1);
  expect(exit[0]!.keyframes).toMatch(/^\[\{"transform":"matrix\(1, 0, 0, 1, 0, \d+(\.\d+)?\)"\},\{"transform":"translateY\(100%\)"\}\]$/);
  await sheetsClosed(page);
});

test('reduced motion: sheets appear and go at once, a drag still follows the finger, presses do not ease', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pair(page, request);
  const sheet = await openNewSession(page);
  expect((await played(page)).filter((p) => p.cls.includes('sheet'))).toEqual([]);

  const rest = (await sheet.boundingBox())!;
  await touchDrag(page, sheet, { x: 200, y: rest.y + 20 }, { x: 200, y: rest.y + 80 }, 10, false, 30);
  expect(await sheet.evaluate((el) => (el as HTMLElement).style.transform)).toMatch(/^translateY\(\d+(\.\d+)?px\)$/);
  await sheet.dispatchEvent('touchend', { touches: [], changedTouches: [] });
  expect(await sheet.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');

  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => document.querySelectorAll('.sheet-backdrop').length)).toBe(0); // no slide-out copy
  expect((await played(page)).filter((p) => p.cls.includes('sheet'))).toEqual([]);

  const button = page.getByRole('button', { name: 'New session' });
  expect(await button.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.001s, 0.001s');
});

test('press feedback: a pressed button dims and shrinks, a full-width bar only dims; no tap flash; iOS gets its touchstart listener', async ({ page, request }) => {
  await pair(page, request);
  const press = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  };
  const look = (target: Locator) => target.evaluate((el) => ({ transform: getComputedStyle(el).transform, opacity: getComputedStyle(el).opacity }));

  const button = page.getByRole('button', { name: 'New session' });
  expect(await button.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color'))).toBe('rgba(0, 0, 0, 0)');
  expect(await button.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.09s, 0.09s');
  await press(button);
  await expect.poll(() => look(button)).toEqual({ transform: 'matrix(0.97, 0, 0, 0.97, 0, 0)', opacity: '0.7' });
  await page.mouse.move(5, 5); // slide off before lifting: no click
  await page.mouse.up();
  await expect.poll(() => look(button)).toEqual({ transform: 'none', opacity: '1' });

  // A session row, a full-width row on the page (look step 6), only dims and keeps its colour. Held with the
  // mouse, the row's own long-press would open its actions sheet, so the pressed state is forced through
  // DevTools instead.
  const cdp = await page.context().newCDPSession(page);
  const row = page.getByRole('list', { name: 'Sessions' }).getByRole('link').first();
  const colour = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'a.session' });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
  await expect.poll(() => look(row)).toEqual({ transform: 'none', opacity: '0.7' });
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(colour);
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });

  // The sheet's full-width Start session bar dims in place.
  const sheet = await openNewSession(page);
  await sheetsSettled(page);
  const start = sheet.getByRole('button', { name: 'Start session' });
  await expect(start).toBeEnabled();
  await press(start);
  await expect.poll(() => look(start)).toEqual({ transform: 'none', opacity: '0.7' });
  await page.mouse.move(5, 300);
  await page.mouse.up();

  // One passive touchstart listener on the document makes iOS Safari apply :active.
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
  expect(listeners.filter((l) => l.type === 'touchstart')).toEqual([expect.objectContaining({ passive: true })]);
});

test('haptic tick: Accept on an approval and Send in the session composer', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_2'); // seeded waiting for its command approval
  const card = page.getByRole('group', { name: 'Approval: Run this command?' });
  await card.getByRole('button', { name: 'Decline' }).focus(); // not a tap: no tick
  expect(await page.evaluate(() => window.__ticks)).toBe(0);
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__ticks)).toBe(1);

  await page.goto('/s/ses_fake_3');
  await page.getByRole('textbox', { name: 'Message' }).fill('Sketch the README.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(await page.evaluate(() => window.__ticks)).toBe(1); // a new page: the count started again
});

test('haptic tick: Send in local chat', async ({ page }) => {
  const provider = {
    id: 'prv_cloud',
    name: 'Fake Cloud',
    baseURL: 'https://api.fake-provider.test:4174/v1',
    kind: 'openai-compatible',
    apiKeyFingerprint: 'sk-fak',
    models: { list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' }], lastProbedAt: 1 },
    hiddenModels: [],
    pinnedModels: [],
    supportsTools: 'unknown',
    refresh: { mode: 'manual' },
  };
  await page.goto('/pair');
  await page.evaluate((p) => {
    localStorage.clear();
    localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [p], defaultProviderId: p.id }));
    localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { [p.id]: 'sk-fake-key' } }));
    localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [] }));
  }, provider);
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Message').fill('Say hi in three words.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.chat-message.assistant .msg.agent')).toHaveText('Hey there, friend!');
  expect(await page.evaluate(() => window.__ticks)).toBe(1);
});
