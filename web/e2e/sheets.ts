import { expect, type Locator, type Page } from '@playwright/test';

// Waiting for sheets to stop moving (src/ui/motion/sheet-motion.ts). A sheet slides up on a spring when it
// opens; when its owner closes it, an inert copy of it (.sheet-ghost: no dialog role, aria-hidden) slides
// out over the page and is then removed. The dialog itself is gone at once, so `toHaveCount(0)` on it passes
// while the copy is still visible, and the copy's labels and text still match getByLabel or getByText.
// Wait on the animations here instead of sleeping a fixed time.

/** Resolves once no sheet moves: every entrance has settled and every closed sheet's copy has gone. */
export async function sheetsSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector('.sheet-ghost') === null && [...document.querySelectorAll('.sheet, .sheet-scrim')].every((el) => el.getAnimations().length === 0),
      ),
    )
    .toBe(true);
}

/** Resolves once no sheet is on the page any more, its slide-out included. */
export async function sheetsClosed(page: Page): Promise<void> {
  await expect(page.locator('.sheet-backdrop')).toHaveCount(0);
}

/** Opens the session's ⋯ details sheet (the centred header's round button) and waits for it to settle. */
export async function openDetails(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Session details' }).click();
  const sheet = page.getByRole('dialog').filter({ has: page.getByRole('list', { name: 'Session details' }) });
  await expect(sheet).toBeVisible();
  await sheetsSettled(page);
  return sheet;
}

/** Closes the ⋯ sheet with Done and waits for its slide-out copy to go. */
export async function closeDetails(page: Page, sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
  await sheetsSettled(page);
}

/**
 * The model and effort the ⋯ sheet names (its Model row: "<model> · <effort>"); `effort: null` means the row
 * names none. Opens the sheet, checks, closes it.
 */
export async function expectSettings(page: Page, expected: { model: string; effort?: string | null }): Promise<void> {
  const sheet = await openDetails(page);
  await expect(sheet.getByLabel('Model', { exact: true })).toHaveText(expected.model);
  if (expected.effort === null) await expect(sheet.getByLabel('Effort', { exact: true })).toHaveCount(0);
  else if (expected.effort !== undefined) await expect(sheet.getByLabel('Effort', { exact: true })).toHaveText(expected.effort);
  await closeDetails(page, sheet);
}
