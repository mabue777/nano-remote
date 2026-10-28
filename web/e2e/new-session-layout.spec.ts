import { expect, test, type Locator, type Page } from './worker-host';

import { sheetsSettled } from './sheets';

// The bypass row on the new-session sheet at 390 x 844 (operator phone check 2026-10-22): the label sits on
// one line, the switch at the row's right edge, and the row does not overlap the folder suggestion above or
// the title label below, with the switch off and on. The warning shows below the row when on.

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSheet(page: Page, code: string): Promise<Locator> {
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('list', { name: 'Recent folders' })).toBeVisible();
  await sheetsSettled(page); // measured at rest, not mid-slide
  return sheet;
}

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function checkRow(sheet: Locator): Promise<void> {
  const toggle = sheet.getByRole('switch', { name: 'Bypass approvals (full access)' });
  const label = sheet.getByText('Bypass approvals (full access)', { exact: true });
  const row = label.locator('xpath=..'); // the row is whatever holds the label, so this also measures older markup
  await expect(row.getByRole('switch')).toHaveCount(1); // the toggle sits in the label's row
  await expect(toggle).toBeVisible();

  const fontSize = await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const labelBox = await box(label);
  expect(labelBox.height, 'label on one line').toBeLessThan(1.6 * fontSize);

  const rowBox = await box(row);
  const sheetBox = await box(sheet);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
  expect(rowBox.width, 'row spans the form').toBeGreaterThan(sheetBox.width / 2);
  // The label stays inside its row.
  expect(labelBox.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);

  // The switch sits at the row's right edge.
  const toggleBox = await box(toggle);
  expect(rowBox.x + rowBox.width - (toggleBox.x + toggleBox.width)).toBeLessThanOrEqual(1);
  expect(toggleBox.x).toBeGreaterThan(labelBox.x + labelBox.width);

  const title = await box(sheet.getByText('Title (optional)', { exact: true }));
  const folder = await box(sheet.getByRole('list', { name: 'Recent folders' }));
  expect(intersects(rowBox, title), 'row overlaps the title label').toBe(false);
  expect(intersects(labelBox, title), 'label overlaps the title label').toBe(false);
  expect(intersects(rowBox, folder), 'row overlaps the folder suggestion').toBe(false);
  expect(intersects(labelBox, folder), 'label overlaps the folder suggestion').toBe(false);
}

test('the bypass row fits a 390 px phone: one-line label, switch at the right, no overlap, off and on', async ({ page, request }) => {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  const sheet = await openSheet(page, code);
  const toggle = sheet.getByRole('switch', { name: 'Bypass approvals (full access)' });
  const warning = sheet.getByRole('note');

  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(warning).toHaveCount(0);
  await checkRow(sheet);
  await sheet.screenshot({ path: test.info().outputPath('new-session-bypass-off-390.png') });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(warning).toBeVisible();
  await checkRow(sheet);
  // The warning sits below the row, outside it, and above the title label.
  const row = sheet.getByText('Bypass approvals (full access)', { exact: true }).locator('xpath=..');
  await expect(row.getByRole('note')).toHaveCount(0);
  const rowBox = await box(row);
  const warningBox = await box(warning);
  const title = await box(sheet.getByText('Title (optional)', { exact: true }));
  expect(warningBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height);
  expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(title.y);
  await sheet.screenshot({ path: test.info().outputPath('new-session-bypass-on-390.png') });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(warning).toHaveCount(0);
});
