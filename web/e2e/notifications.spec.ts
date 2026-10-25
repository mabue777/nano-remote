import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Web Push on the phone (spec 9) against the built app: the Notifications section, first on the Settings
// screen. An init script stands in for Notification and PushManager (headless Chromium has no push
// service), so the switch goes off -> on and the fake host receives push/subscribe with the stubbed
// subscription; the test button reaches push/test; an iPhone outside the home-screen app is told to
// install. Home shows only a one-line pointer to Settings while notifications are off.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const STUB_SUBSCRIPTION = { endpoint: 'https://push.example/e2e-stub', expirationTime: null, keys: { p256dh: 'BStubP256dhKey', auth: 'stubAuthSecret' } };

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pairAndLand(page: Page, request: APIRequestContext): Promise<string> {
  const { code } = (await (await request.post('/test/code')).json()) as { code: string };
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('status').first()).toHaveAttribute('data-state', 'connected');
  return page.evaluate(() => JSON.parse(localStorage.getItem('nano-remote.device.v1') ?? '{}').clientId ?? '');
}

const HINT = 'Turn on notifications in Settings';

/** Pairs, lands on Home, then taps the gear: Settings. */
async function pairAndOpenSettings(page: Page, request: APIRequestContext): Promise<string> {
  const clientId = await pairAndLand(page, request);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  return clientId;
}

async function pushState(request: APIRequestContext) {
  return (await (await request.post('/test/push')).json()) as { subscriptions: Record<string, unknown>; tests: string[] };
}

/** Notification that grants on request, and a PushManager that hands out STUB_SUBSCRIPTION. */
async function stubPush(page: Page) {
  await page.addInitScript((stub) => {
    const notification = {
      permission: 'default' as NotificationPermission,
      async requestPermission() {
        notification.permission = 'granted';
        return 'granted' as NotificationPermission;
      },
    };
    Object.defineProperty(window, 'Notification', { value: notification, configurable: true, writable: true });
    let current: unknown = null;
    const record = ((window as unknown as { __push: unknown[] }).__push = [] as unknown[]);
    PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      record.push({ userVisibleOnly: options?.userVisibleOnly, keyBytes: new Uint8Array(options?.applicationServerKey as Uint8Array).length });
      current = {
        endpoint: stub.endpoint,
        options: { applicationServerKey: null },
        toJSON: () => stub,
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return current as PushSubscription;
    };
  }, STUB_SUBSCRIPTION);
}

test('the switch goes off -> on and the host receives push/subscribe with the subscription; off tells the host too', async ({ page, request }) => {
  await stubPush(page);
  await pairAndOpenSettings(page, request);

  const card = page.getByRole('region', { name: 'Notifications' });
  const toggle = card.getByRole('switch', { name: 'Notifications' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card).toHaveAttribute('data-state', 'off');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(card).toHaveAttribute('data-state', 'on');
  const last = (await (await request.post('/test/last', { data: { method: 'push/subscribe' } })).json()) as { params: unknown };
  expect(last.params).toEqual({ subscription: STUB_SUBSCRIPTION });
  expect(Object.values((await pushState(request)).subscriptions)).toEqual([STUB_SUBSCRIPTION]);
  // userVisibleOnly and the host's 65-byte VAPID key, decoded from base64url.
  expect(await page.evaluate(() => (window as unknown as { __push: unknown[] }).__push)).toEqual([{ userVisibleOnly: true, keyBytes: 65 }]);

  // A reload reconnects: the host says subscribed, but this (stubbed) browser lost its subscription, so
  // the switch shows off rather than promising pushes; turning it on subscribes again.
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const unsubscribed = (await (await request.post('/test/last', { data: { method: 'push/unsubscribe' } })).json()) as { params: unknown };
  expect(unsubscribed.params).toEqual({ endpoint: STUB_SUBSCRIPTION.endpoint });
  await expect.poll(async () => Object.keys((await pushState(request)).subscriptions)).toEqual([]);
});

test('Send test notification calls push/test, and shows the host refusal in words', async ({ page, request }) => {
  await stubPush(page);
  const clientId = await pairAndOpenSettings(page, request);
  const card = page.getByRole('region', { name: 'Notifications' });
  await card.getByRole('switch', { name: 'Notifications' }).click();
  await expect(card).toHaveAttribute('data-state', 'on');

  await card.getByRole('button', { name: 'Send test notification' }).click();
  await expect(card.getByRole('status')).toHaveText(/Sent/);
  expect((await pushState(request)).tests).toEqual([clientId]);

  await request.post('/test/push-test-error', { data: { code: 'not_found', message: 'subscription expired', data: { reason: 'subscription_expired' } } });
  await card.getByRole('button', { name: 'Send test notification' }).click();
  await expect(card.getByRole('alert')).toHaveText('The subscription expired. Turn notifications off and on again.');
  expect((await pushState(request)).tests).toEqual([clientId, clientId]);
});

test.describe('on an iPhone in a Safari tab', () => {
  test.use({ userAgent: IPHONE });

  test('Home points at Settings; there the section asks for a home-screen install and offers no switch', async ({ page, request }) => {
    await pairAndLand(page, request);
    await expect(page.getByRole('link', { name: HINT })).toBeVisible();
    await page.getByRole('link', { name: HINT }).click();
    await expect(page).toHaveURL(/\/settings$/);
    const card = page.getByRole('region', { name: 'Notifications' });
    await expect(card).toHaveAttribute('data-state', 'needs-install');
    await expect(card).toContainText('Install to the home screen from Safari to get notifications');
    await expect(card.getByRole('switch')).toHaveCount(0);
    expect(await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches)).toBe(false);
  });
});

test('Home has no Notifications card: one line points at Settings while off, and it is gone once on', async ({ page, request }) => {
  await stubPush(page);
  await pairAndLand(page, request);
  await expect(page.getByRole('region', { name: 'Host' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notifications' })).toHaveCount(0);
  const hint = page.getByRole('link', { name: HINT });
  await expect(hint).toHaveAttribute('href', '/settings');
  // It sits right under the host card.
  expect(await page.locator('section.host + p.notifications-hint').count()).toBe(1);

  await hint.click();
  await expect(page).toHaveURL(/\/settings$/);
  const toggle = page.getByRole('region', { name: 'Notifications' }).getByRole('switch', { name: 'Notifications' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await page.locator('a.back').click(); // Back (to Chats)
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('region', { name: 'Host' })).toBeVisible();
  await expect(page.getByRole('link', { name: HINT })).toHaveCount(0);
});

test('the gear opens Settings with Notifications first, then This Mac, then Providers', async ({ page, request }) => {
  await stubPush(page);
  await pairAndOpenSettings(page, request);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByRole('heading', { name: 'This Mac' })).toBeVisible();
  const order = await page.locator('main.settings-screen h2').allTextContents();
  expect(order.slice(0, 3)).toEqual(['Notifications', 'This Mac', 'Providers']);
});

test('the old address /settings/providers still opens Settings', async ({ page, request }) => {
  await stubPush(page);
  await pairAndLand(page, request);
  await page.goto('/settings/providers');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByRole('region', { name: 'Notifications' })).toHaveAttribute('data-state', 'off');
  await expect(page.getByRole('heading', { name: 'Providers', level: 2 })).toBeVisible();
});
