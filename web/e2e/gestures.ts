import { expect, type Locator } from '@playwright/test';

// Touch gestures for rows that use usePress (src/screens/chat/hooks.tsx), sent as pointer events.
//
// A long-press holds until the page shows its result, the way a finger stays down until the menu
// appears. Do not hold for a fixed time measured in the test: the press timer runs in the page, and in
// headless Chromium it fires late (measured 540-680 ms for a 500 ms timer), often only when the next
// event from the test wakes the page. A fixed 650 ms hold then races the timer, and under machine load
// pointerup can arrive first and cancel the press.

/** Presses `target` and keeps holding until `shown` is visible, then lifts. */
export async function longPress(target: Locator, shown: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 0, pointerType: 'touch', isPrimary: true };
  await target.dispatchEvent('pointerdown', at);
  await expect(shown).toBeVisible();
  await target.dispatchEvent('pointerup', at);
}

/** Drags `target` 100 px to the left from near its right edge. */
export async function swipeLeft(target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const y = box.y + box.height / 2;
  const base = { button: 0, pointerType: 'touch', isPrimary: true, clientY: y };
  await target.dispatchEvent('pointerdown', { ...base, clientX: box.x + box.width - 20 });
  await target.dispatchEvent('pointermove', { ...base, clientX: box.x + box.width - 60 });
  await target.dispatchEvent('pointermove', { ...base, clientX: box.x + box.width - 120 });
  await target.dispatchEvent('pointerup', { ...base, clientX: box.x + box.width - 120 });
}
