import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// No zoom anywhere (operator decision 2026-10-24), at 390 x 844 against the fake host:
// - pinch and double-tap: touch-action pan-x pan-y on html and body (styles/base.css) and Safari's gesture
//   events cancelled on the document (src/ui/no-zoom.ts); one-finger touches are never cancelled, and
//   sideways scrollers (diff, code, command boxes) keep their horizontal panning;
// - the viewport tag carries maximum-scale=1 and user-scalable=no;
// - focus zoom: iOS zooms into a text field under 16 px, so every field on every screen that has one
//   (pair, new session, composer, question "Other", local chat, provider settings, the lab in both looks)
//   is checked for a computed font size of at least 16 px.
//
// Chromium has no gesture events and does not zoom like iOS; whether the iPhone really stops zooming is
// confirmed on the operator's phone. These checks hold the pieces in place.

const PROVIDER_PORT = 4174;
const CLOUD = {
  id: 'prv_cloud',
  name: 'Fake Cloud',
  baseURL: `https://api.fake-provider.test:${PROVIDER_PORT}/v1`,
  kind: 'openai-compatible',
  apiKeyFingerprint: 'sk-fak',
  models: { list: [{ id: 'fake-reasoner', displayName: 'Fake Reasoner', capabilities: { tools: true, reasoning: true }, source: 'vendor' }], lastProbedAt: 1 },
  hiddenModels: [],
  pinnedModels: [],
  supportsTools: 'unknown',
  refresh: { mode: 'manual' },
};

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

/** Every text field on the page (inputs a keyboard types into, textareas, selects) with its computed font size. */
async function fields(page: Page): Promise<{ field: string; px: number }[]> {
  return page.evaluate(() => {
    const notTyped = new Set(['radio', 'checkbox', 'file', 'hidden', 'range', 'color', 'button', 'submit', 'reset', 'image']);
    return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')]
      .filter((el) => !(el instanceof HTMLInputElement && notTyped.has(el.type)))
      .map((el) => {
        const name = el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.closest('label')?.textContent?.trim().slice(0, 30) ?? '';
        return { field: `${el.tagName.toLowerCase()}${el.className ? `.${el.className.split(' ').join('.')}` : ''} "${name}"`, px: parseFloat(getComputedStyle(el).fontSize) };
      });
  });
}

/** Asserts the page has at least `atLeast` text fields and every one is 16 px or larger. */
async function expectNoFocusZoom(page: Page, atLeast: number): Promise<void> {
  const found = await fields(page);
  expect(found.length, JSON.stringify(found)).toBeGreaterThanOrEqual(atLeast);
  expect(found.filter((f) => f.px < 16)).toEqual([]);
}

test('viewport tag, touch-action and the gesture listeners: pinch and double-tap zoom off, one-finger touches untouched', async ({ page }) => {
  await page.goto('/pair');
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toBe(
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  );
  expect(await page.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).touchAction))).toEqual(['pan-x pan-y', 'pan-x pan-y']);

  const outcome = await page.evaluate(() => {
    const fire = (target: EventTarget, event: Event) => {
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const field = document.querySelector('input')!;
    const touch = (type: string, fingers: number) => {
      const touches = Array.from({ length: fingers }, (_, i) => new Touch({ identifier: i, target: field, clientX: 100 + i * 50, clientY: 300 }));
      return new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true });
    };
    return {
      // Safari's pinch events, from the document and bubbling up from a field.
      gestures: ['gesturestart', 'gesturechange', 'gestureend'].map((type) => fire(field, new Event(type, { bubbles: true, cancelable: true }))),
      // One finger: a scroll, the sheet drag, pull-to-refresh and the swipes all start like this.
      oneFinger: ['touchstart', 'touchmove', 'touchend'].map((type) => fire(field, touch(type, 1))),
    };
  });
  expect(outcome).toEqual({ gestures: [true, true, true], oneFinger: [false, false, false] });
});

test('sideways scrollers (the diff preview, code and command boxes) keep horizontal panning', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_1');
  await expect(page.getByRole('heading', { name: 'Create hello.txt and list files' })).toBeVisible();
  // A diff preview: the fileChange approval card (approvals.spec.ts) shows one.
  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_1',
      request: {
        kind: 'fileChange',
        changes: [{ path: 'src/a-really-long-file-name-that-will-not-fit.ts', kind: 'modify', diff: `@@ -1 +1 @@\n-${'old '.repeat(40)}\n+${'new '.repeat(40)}` }],
        reason: 'Rename things.',
        availableDecisions: ['accept', 'decline'],
      },
    },
  });
  await expect(page.locator('.diff, pre').first()).toBeVisible();

  // No element on the page restricts touches to vertical panning where content scrolls sideways.
  const blocked = await page.evaluate(() => {
    const allowsPanX = (el: Element | null): boolean => {
      for (let node = el; node; node = node.parentElement) {
        const value = getComputedStyle(node).touchAction;
        if (value === 'none' || (value !== 'auto' && value !== 'manipulation' && !value.includes('pan-x'))) return false;
      }
      return true;
    };
    const sideways = [...document.querySelectorAll('*')].filter((el) => {
      const overflow = getComputedStyle(el).overflowX;
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollWidth > el.clientWidth;
    });
    return { count: sideways.length, blocked: sideways.filter((el) => !allowsPanX(el)).map((el) => el.className) };
  });
  expect(blocked.count).toBeGreaterThan(0);
  expect(blocked.blocked).toEqual([]);
});

test('focus zoom: every field in the real app is at least 16 px (pair, new session, composer, question, chat, settings)', async ({ page, request }) => {
  await page.goto('/pair');
  await expect(page.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
  await expectNoFocusZoom(page, 1);

  await page.goto('about:blank'); // a hash change alone does not reload /pair with the code
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByLabel('Model')).toBeVisible();
  await expectNoFocusZoom(page, 3); // model, title, first message (and effort where offered)
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);

  // The session composer, then a question with an "Other" field and a secret answer.
  await page.goto('/s/ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await expectNoFocusZoom(page, 1);
  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_3',
      request: {
        kind: 'input',
        isBlocking: true,
        questions: [
          { id: 'sections', header: 'Sections', question: 'Which sections?', options: [{ label: 'Install', description: '' }], multiSelect: true, isOther: true, isSecret: false },
          { id: 'token', header: 'Token', question: 'Your npm token?', isOther: false, isSecret: true },
        ],
      },
    },
  });
  await expect(page.getByRole('textbox', { name: 'Other answer to Sections' })).toBeVisible();
  await expectNoFocusZoom(page, 3);

  // Provider settings: the add form with its key, URL and name fields.
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: 'Add provider' }).click();
  await page.getByLabel('Paste an API key or a server URL').fill('sk-proj-e2e-0123456789');
  await expect(page.getByLabel('Base URL')).toBeVisible();
  await expectNoFocusZoom(page, 3);
});

test('focus zoom: the local chat composer is at least 16 px', async ({ page }) => {
  await page.goto('/pair');
  await page.evaluate((provider) => {
    localStorage.clear();
    localStorage.setItem('nano-remote/providers/v1', JSON.stringify({ v: 1, providers: [provider], defaultProviderId: provider.id }));
    localStorage.setItem('nano-remote/provider-keys/v1', JSON.stringify({ v: 1, keys: { [provider.id]: 'sk-fake-key' } }));
    localStorage.setItem('nano-remote/chats/v1', JSON.stringify({ v: 1, chats: [] }));
  }, CLOUD);
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByLabel('Message')).toBeVisible();
  await expectNoFocusZoom(page, 1);
});

test('focus zoom: every field in the lab is at least 16 px, in the Now and the New look', async ({ page }) => {
  await page.goto('/lab?speed=40');
  for (const look of ['Now', 'New'] as const) {
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Lab' });
    await panel.getByRole('group', { name: 'Look' }).getByRole('button', { name: look, exact: true }).click();
    await panel.getByRole('button', { name: 'All Now' }).click();
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(panel).toBeHidden();

    await page.getByRole('button', { name: 'New session' }).click();
    const create = page.getByRole('dialog', { name: 'New session' });
    await expect(create).toBeVisible();
    await expectNoFocusZoom(page, 1);
    await create.getByRole('button', { name: 'Cancel' }).click();
    await expect(create).toBeHidden();

    // The session composer, then the question card the reply ends in (its "Other" field in the New look).
    await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Fix the failing parser test/ }).click();
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await expect(conversation).toContainText('push the fix to a branch', { timeout: 15_000 });
    const field = page.getByRole('textbox', { name: 'Message' });
    await expectNoFocusZoom(page, 1);
    await field.fill('Keep it small.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(conversation.getByRole('group', { name: /^Question: / })).toBeVisible({ timeout: 15_000 });
    await expectNoFocusZoom(page, look === 'New' ? 2 : 1);
    await page.goto('/lab?speed=40');
  }
});
