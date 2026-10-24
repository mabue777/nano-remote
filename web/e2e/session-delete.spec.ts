import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { longPress, swipeLeft } from './gestures';
import { sheetsSettled } from './sheets';

// Archive and delete sessions from the phone (spec 6) against the fake host: a swipe on a Home row shows
// Archive and Delete, a long-press opens the same actions in a sheet; Archive moves the row to the
// "Archived" section with an Undo toast; Delete always asks first (and says a working session stops);
// "Delete all archived" states the count; the session view has the same actions in its header menu.
// With SESSION_DELETE_OUT set, the last test also writes light and dark screenshots there.

const FINISHED = 'Create hello.txt and list files'; // ses_fake_1
const WAITING = 'Run the test suite'; // ses_fake_2, waiting for an approval
const FRESH = 'Sketch the README'; // ses_fake_3, on the second page
const CONFIRM = 'Its history and attachments are removed from your Mac. This cannot be undone.';
const STOPS = 'It is still working: its turn and any background tasks will be stopped.';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(sessions(page).getByRole('link')).toHaveCount(3); // the second page arrives by infinite scroll
}

const sessions = (page: Page) => page.getByRole('list', { name: 'Sessions', exact: true });
const archived = (page: Page) => page.getByRole('list', { name: 'Archived sessions' });
const row = (page: Page, title: string) => sessions(page).getByRole('link', { name: new RegExp(title) });
const toggle = (page: Page) => page.getByRole('button', { name: /^Archived/ });

async function lastParams(request: APIRequestContext, method: string): Promise<unknown> {
  return ((await (await request.post('/test/last', { data: { method } })).json()) as { params: unknown }).params;
}

test('swipe to archive: the row moves to Archived without asking, and Undo brings it back', async ({ page, request }) => {
  await pair(page, request);
  await expect(toggle(page)).toHaveCount(0); // no section while nothing is archived

  await swipeLeft(row(page, FINISHED));
  await page.getByRole('button', { name: `Archive ${FINISHED}` }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); // no confirmation
  await expect(row(page, FINISHED)).toHaveCount(0);
  await expect(toggle(page)).toHaveText(/Archived\s*1/);
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  const toast = page.locator('.undo-toast');
  await expect(toast).toContainText(`Archived ${FINISHED}`);
  expect(await lastParams(request, 'session/archive')).toEqual({ sessionId: 'ses_fake_1' });

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, FINISHED)).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await expect(toast).toHaveCount(0);
  expect(await lastParams(request, 'session/unarchive')).toEqual({ sessionId: 'ses_fake_1' });

  // The archive lasts across a reload (the host lists it under Archived); the toast goes by itself.
  await swipeLeft(row(page, FRESH));
  await page.getByRole('button', { name: `Archive ${FRESH}` }).click();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 8000 });
  await page.reload();
  await expect(toggle(page)).toHaveText(/Archived\s*1/);
  await toggle(page).click();
  await expect(archived(page).getByRole('link')).toHaveText([new RegExp(FRESH)]);
});

test('long-press opens the actions sheet; Delete asks first and Cancel keeps the session', async ({ page, request }) => {
  await pair(page, request);
  const sheet = page.getByRole('dialog', { name: FINISHED });
  await longPress(row(page, FINISHED), sheet);
  await expect(sheet.getByRole('button')).toHaveText(['Archive', 'Delete…', 'Cancel']);
  await sheet.getByRole('button', { name: 'Delete…' }).click();

  const confirm = page.getByRole('dialog', { name: `Delete ${FINISHED}?` });
  await expect(confirm).toContainText(CONFIRM);
  await expect(confirm).not.toContainText(STOPS);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, FINISHED)).toBeVisible();
  expect(await lastParams(request, 'session/delete')).toBeNull();

  await longPress(row(page, FINISHED), sheet);
  await sheet.getByRole('button', { name: 'Delete…' }).click();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, FINISHED)).toHaveCount(0);
  expect(await lastParams(request, 'session/delete')).toEqual({ sessionId: 'ses_fake_1' });
  await page.reload();
  await expect(sessions(page).getByRole('link')).toHaveCount(2);
  await expect(row(page, FINISHED)).toHaveCount(0);
});

test('a working session: the confirmation says its turn and background tasks stop', async ({ page, request }) => {
  await pair(page, request);
  await request.post('/test/background', {
    data: { sessionId: 'ses_fake_2', tasks: [{ id: 'tsk_1', title: 'watch the build', status: 'running', startedAt: Math.floor(Date.now() / 1000) }] },
  });
  await swipeLeft(row(page, WAITING));
  await page.getByRole('button', { name: `Delete ${WAITING}` }).click();
  const confirm = page.getByRole('dialog', { name: `Delete ${WAITING}?` });
  await expect(confirm).toContainText(CONFIRM);
  await expect(confirm).toContainText(STOPS);
  await confirm.getByRole('button', { name: 'Stop and delete' }).click();
  await expect(row(page, WAITING)).toHaveCount(0);
  expect(await lastParams(request, 'session/delete')).toEqual({ sessionId: 'ses_fake_2' });
  // Stopping the turn and the task changed the session after the row went: it must not come back.
  await expect(sessions(page).getByRole('link')).toHaveText([new RegExp(FINISHED), new RegExp(FRESH)]);
  await expect(toggle(page)).toHaveCount(0);
});

test('a working session: Archive asks first too, and "Stop and archive" moves it to Archived', async ({ page, request }) => {
  await pair(page, request);
  await request.post('/test/background', {
    data: { sessionId: 'ses_fake_2', tasks: [{ id: 'tsk_1', title: 'watch the build', status: 'running', startedAt: Math.floor(Date.now() / 1000) }] },
  });
  await swipeLeft(row(page, WAITING));
  await page.getByRole('button', { name: `Archive ${WAITING}` }).click();
  const confirm = page.getByRole('dialog', { name: `Archive ${WAITING}?` });
  await expect(confirm).toContainText(STOPS);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, WAITING)).toHaveCount(1);
  await expect(page.locator('.undo-toast')).toHaveCount(0); // Cancel archived nothing
  await expect(toggle(page)).toHaveCount(0);

  await swipeLeft(row(page, WAITING));
  await page.getByRole('button', { name: `Archive ${WAITING}` }).click();
  await page.getByRole('dialog', { name: `Archive ${WAITING}?` }).getByRole('button', { name: 'Stop and archive' }).click();
  await expect(row(page, WAITING)).toHaveCount(0);
  await expect(page.locator('.undo-toast')).toContainText(`Archived ${WAITING}`);
  expect(await lastParams(request, 'session/archive')).toEqual({ sessionId: 'ses_fake_2' });
  await expect(sessions(page).getByRole('link')).toHaveText([new RegExp(FINISHED), new RegExp(FRESH)]);
  await expect(toggle(page)).toHaveText(/Archived\s*1/);
});

test('Delete all archived states the count and empties the section', async ({ page, request }) => {
  await pair(page, request);
  for (const title of [FINISHED, FRESH]) {
    await swipeLeft(row(page, title));
    await page.getByRole('button', { name: `Archive ${title}` }).click();
    await expect(row(page, title)).toHaveCount(0);
  }
  await expect(toggle(page)).toHaveText(/Archived\s*2/);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(archived(page).getByRole('link')).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete all archived' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 archived sessions?' });
  await expect(confirm).toContainText('Their history and attachments are removed from your Mac. This cannot be undone.');
  await confirm.getByRole('button', { name: 'Delete 2' }).click();
  await expect(toggle(page)).toHaveCount(0);
  await expect(sessions(page).getByRole('link')).toHaveText([new RegExp(WAITING)]);
  await page.reload();
  await expect(sessions(page).getByRole('link')).toHaveCount(1);
  await expect(toggle(page)).toHaveCount(0);
});

test('the session view: Archive and Delete in the header menu', async ({ page, request }) => {
  await pair(page, request);
  await row(page, FINISHED).click();
  await expect(page.getByRole('heading', { name: FINISHED })).toBeVisible();
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('dialog', { name: FINISHED }).getByRole('button', { name: 'Archive' }).click();
  // Back on Home, with the Undo toast and the session under Archived.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.undo-toast')).toContainText(`Archived ${FINISHED}`);
  await expect(toggle(page)).toHaveText(/Archived\s*1/);

  await row(page, FRESH).click();
  await expect(page.getByRole('heading', { name: FRESH })).toBeVisible();
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('dialog', { name: FRESH }).getByRole('button', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: `Delete ${FRESH}?` });
  await expect(confirm).toContainText(CONFIRM);
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(row(page, FRESH)).toHaveCount(0);
  expect(await lastParams(request, 'session/delete')).toEqual({ sessionId: 'ses_fake_3' });
});

test('screenshots, light and dark: swipe actions, actions sheet, confirmation, Archived section, Undo, header menu', async ({ page, request }) => {
  const out = process.env.SESSION_DELETE_OUT;
  test.skip(out === undefined || out === '', 'set SESSION_DELETE_OUT to capture');
  const shot = async (name: string) => {
    await sheetsSettled(page); // no sheet mid-slide; animations: 'disabled' finishes the switch knob
    await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', caret: 'hide' });
  };
  for (const scheme of ['light', 'dark'] as const) {
    await request.post('/test/reset');
    await page.emulateMedia({ colorScheme: scheme });
    await pair(page, request);
    await swipeLeft(row(page, FINISHED));
    await expect(page.getByRole('button', { name: `Archive ${FINISHED}` })).toBeVisible();
    await shot(`${scheme}-1-swipe-actions`);
    await page.getByRole('button', { name: 'Cancel' }).click();

    const sheet = page.getByRole('dialog', { name: WAITING });
    await longPress(row(page, WAITING), sheet);
    await shot(`${scheme}-2-actions-sheet`);
    await sheet.getByRole('button', { name: 'Delete…' }).click();
    await expect(page.getByRole('dialog', { name: `Delete ${WAITING}?` })).toBeVisible();
    await shot(`${scheme}-3-confirm-working`);
    await page.getByRole('dialog', { name: `Delete ${WAITING}?` }).getByRole('button', { name: 'Cancel' }).click();

    for (const title of [FINISHED, FRESH]) {
      await swipeLeft(row(page, title));
      await page.getByRole('button', { name: `Archive ${title}` }).click();
    }
    await toggle(page).click();
    await expect(page.locator('.undo-toast')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(`${scheme}-4-archived-and-undo`);
    await page.getByRole('button', { name: 'Delete all archived' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete 2 archived sessions?' })).toBeVisible();
    await shot(`${scheme}-5-confirm-delete-all`);
    await page.getByRole('dialog', { name: 'Delete 2 archived sessions?' }).getByRole('button', { name: 'Cancel' }).click();

    await row(page, WAITING).click();
    await page.getByRole('button', { name: 'Session actions' }).click();
    await expect(page.getByRole('dialog', { name: WAITING })).toBeVisible();
    await shot(`${scheme}-6-session-header-menu`);
  }
});
