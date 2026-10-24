import { expect, type Page } from '@playwright/test';

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
