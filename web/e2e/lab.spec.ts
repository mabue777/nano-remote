import { expect, test, type Locator, type Page } from '@playwright/test';

// The interaction lab (/lab, src/lab): it opens without pairing, the Lab panel flips every technique between
// Now and Smooth and keeps the choice over a reload, and the mini app's path (session list -> session ->
// Changes sheet, approve, send, back) works in both modes. The fake stream runs 8x faster (?speed=8).

const TECHNIQUES = [
  'Press feedback',
  'Page push and back swipe',
  'Sheets',
  'Streaming text',
  'Auto-scroll',
  'Sending',
  'Keyboard',
  'List changes',
  'Expand and collapse',
  'Haptic tick',
];

async function openPanel(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Lab' });
  await expect(panel).toBeVisible();
  return panel;
}

async function setAll(page: Page, mode: 'Now' | 'Smooth'): Promise<void> {
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: `All ${mode}` }).click();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();
}

/** A one-finger touch drag dispatched as touch events (the lab's gestures listen to touch events). */
async function touchDrag(page: Page, target: Locator, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6): Promise<void> {
  const point = (x: number, y: number) => [{ identifier: 1, clientX: x, clientY: y }];
  await target.dispatchEvent('touchstart', { touches: point(from.x, from.y), changedTouches: point(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await target.dispatchEvent('touchmove', { touches: point(x, y), changedTouches: point(x, y) });
    await page.waitForTimeout(8);
  }
  await target.dispatchEvent('touchend', { touches: [], changedTouches: point(to.x, to.y) });
}

test('the lab opens without pairing; the panel switches every technique and remembers it', async ({ page }) => {
  await page.goto('/lab');
  await expect(page).toHaveURL(/\/lab$/); // no redirect to /pair
  await expect(page.getByRole('list', { name: 'Sessions' }).getByRole('link')).toHaveCount(5);
  const lab = page.locator('.lab');

  const panel = await openPanel(page);
  await expect(panel.locator('.lab-techniques').getByRole('group')).toHaveCount(TECHNIQUES.length);
  for (const name of TECHNIQUES) {
    const row = panel.getByRole('group', { name });
    await expect(row.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    await row.getByRole('button', { name: 'Smooth' }).click();
    await expect(row.getByRole('button', { name: 'Smooth' })).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'false');
  }
  for (const id of ['press', 'page', 'sheet', 'stream', 'scroll', 'send', 'keyboard', 'list', 'expand', 'haptic']) {
    await expect(lab).toHaveAttribute(`data-${id}`, 'smooth');
  }

  await page.reload();
  await expect(lab).toHaveAttribute('data-sheet', 'smooth'); // kept in localStorage
  const again = await openPanel(page);
  await again.getByRole('button', { name: 'All Now' }).click();
  await expect(lab).toHaveAttribute('data-sheet', 'now');
  await expect(lab).toHaveAttribute('data-haptic', 'now');
  await again.getByRole('group', { name: 'Sheets' }).getByRole('button', { name: 'Smooth' }).click();
  await expect(lab).toHaveAttribute('data-sheet', 'smooth');
  await expect(lab).toHaveAttribute('data-page', 'now');
});

for (const mode of ['Now', 'Smooth'] as const) {
  test(`list -> session -> sheet, approve, send and back (${mode})`, async ({ page }) => {
    await page.goto('/lab?speed=8');
    await setAll(page, mode);

    // List changes: the scripted activity adds a row at the top.
    const sessions = page.getByRole('list', { name: 'Sessions' });
    await page.getByRole('button', { name: 'Simulate activity' }).click();
    await expect(sessions.getByRole('link').first()).toContainText('Fix the lint warnings');

    // New session sheet opens and closes.
    await page.getByRole('button', { name: 'New session' }).click();
    const create = page.getByRole('dialog', { name: 'New session' });
    await expect(create).toBeVisible();
    await create.getByRole('button', { name: 'Cancel' }).click();
    await expect(create).toBeHidden();

    // Into the session.
    await sessions.getByRole('link', { name: /Fix the failing parser test/ }).click();
    await expect(page.getByRole('heading', { name: 'Fix the failing parser test' })).toBeVisible();
    await expect(sessions).toBeHidden();
    const conversation = page.getByRole('region', { name: 'Conversation' });

    // A tool row opens and closes.
    const tool = conversation.getByRole('button', { name: /npm test -- parser/ });
    await tool.click();
    await expect(conversation.getByText('Tests  1 failed | 11 passed (12)')).toBeVisible();
    await tool.click();
    await expect(conversation.getByText('Tests  1 failed | 11 passed (12)')).toBeHidden();

    // The answer streams to its end; then the approval card and the changes link appear.
    await expect(conversation).toContainText('push the fix to a branch', { timeout: 15_000 });
    const approval = conversation.getByRole('group', { name: 'Approval: Run a command?' });
    await expect(approval).toBeVisible();

    // The Changes sheet.
    await conversation.getByRole('button', { name: '3 files changed ›' }).click();
    const changes = page.getByRole('dialog', { name: 'Changes' });
    await expect(changes).toBeVisible();
    await expect(changes.getByRole('list', { name: 'Changed files' }).getByRole('listitem')).toHaveCount(3);
    await changes.getByRole('button', { name: 'Close' }).click();
    await expect(changes).toBeHidden();

    // Approve: the card collapses into an answered line.
    await approval.getByRole('button', { name: 'Accept' }).click();
    await expect(conversation.getByLabel('Approval answered')).toContainText('Approved');
    await expect(page.getByLabel('Session status')).toContainText('Finished');

    // Send: the message shows at once, the composer clears, a reply streams.
    const field = page.getByRole('textbox', { name: 'Message' });
    await field.fill('Keep it small.\nNo refactor.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(field).toHaveValue('');
    await expect(conversation.locator('.msg.user').last()).toContainText('Keep it small.');
    await expect(conversation).toContainText('depends on the old behaviour', { timeout: 15_000 });

    // Back to the list.
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(sessions).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fix the failing parser test' })).toBeHidden();
  });
}

test('press feedback: Now keeps the old press (no dim, no shrink, the tap flash), Smooth is the app\'s', async ({ page }) => {
  await page.goto('/lab');
  const button = page.getByRole('button', { name: 'New session' });
  const look = () => button.evaluate((el) => ({ transform: getComputedStyle(el).transform, opacity: getComputedStyle(el).opacity, flash: getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color') }));
  const hold = async () => {
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  };
  const lift = async () => {
    await page.mouse.move(5, 400); // off the button first: no click
    await page.mouse.up();
  };
  for (const mode of ['Now', 'Smooth'] as const) {
    await setAll(page, mode);
    await hold();
    if (mode === 'Now') {
      await page.waitForTimeout(150); // longer than the 90 ms press: nothing should have moved
      expect(await look()).toEqual({ transform: 'none', opacity: '1', flash: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/) });
    } else {
      await expect.poll(look).toEqual({ transform: 'matrix(0.97, 0, 0, 0.97, 0, 0)', opacity: '0.7', flash: 'rgba(0, 0, 0, 0)' });
    }
    await lift();
  }
});

test('Smooth gestures: a sheet dragged down dismisses, a short drag springs back, an edge swipe goes back', async ({ page }) => {
  await page.goto('/lab?speed=8');
  await setAll(page, 'Smooth');

  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(700); // the spring entrance settles
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeCloseTo(844, 0); // resting on the bottom edge
  // A short, slow drag springs back.
  await touchDrag(page, sheet, { x: 200, y: box.y + 20 }, { x: 200, y: box.y + 50 }, 10);
  await page.waitForTimeout(700);
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.y).toBeCloseTo(box.y, 0);
  // A long drag dismisses.
  await touchDrag(page, sheet, { x: 200, y: box.y + 20 }, { x: 200, y: box.y + box.height * 0.7 });
  await expect(sheet).toBeHidden();

  await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Fix the failing parser test/ }).click();
  const heading = page.getByRole('heading', { name: 'Fix the failing parser test' });
  await expect(heading).toBeVisible();
  await page.waitForTimeout(400); // the push transition ends
  // A swipe that starts away from the edge does nothing.
  await touchDrag(page, page.locator('.lab-session-page'), { x: 120, y: 400 }, { x: 380, y: 400 });
  await expect(heading).toBeVisible();
  // From the left edge it goes back.
  await touchDrag(page, page.locator('.lab-session-page'), { x: 10, y: 400 }, { x: 300, y: 405 });
  await expect(heading).toBeHidden();
  await expect(page.getByRole('list', { name: 'Sessions' })).toBeVisible();
});

test('the lab renders in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/lab?speed=8');
  await expect(page.locator('.lab')).toHaveAttribute('data-look', 'now'); // the lab's chunk and stylesheets are in
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(18, 18, 17)'); // --bg dark, #121211: the earlier palette, kept for Now (now-look.css)
  await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Fix the failing parser test/ }).click();
  await expect(page.getByRole('heading', { name: 'Fix the failing parser test' })).toBeVisible();
});
