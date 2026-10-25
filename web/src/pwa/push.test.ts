import { describe, expect, it } from 'vitest';

import {
  browserPushEnvironment,
  ENDPOINT_STORAGE_KEY,
  isIos,
  NOTIFICATIONS_HINT,
  notificationsHint,
  PushModel,
  testErrorText,
  urlBase64ToUint8Array,
  type Permission,
  type PushClient,
  type PushEnvironment,
  type PushWindow,
  type SubscriptionLike,
} from './push';

const KEY = 'BLqV9YHYYANsdXdPRsHojo-QK0K6dl2lGcRree27K9no9AcPff1jvU8tGx_aQzuS6fueSsuSEJ3HyKFOXfaGoPw';
const OTHER_KEY = 'BOrOtherHostKeyAfterReinstallAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeSubscription implements SubscriptionLike {
  unsubscribed = false;
  readonly options: { applicationServerKey: ArrayBuffer | null };
  constructor(
    private readonly manager: FakePushManager,
    readonly endpoint: string,
    key: string | null,
  ) {
    this.options = { applicationServerKey: key === null ? null : urlBase64ToUint8Array(key).buffer as ArrayBuffer };
  }
  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'p256dh-' + this.endpoint, auth: 'auth' } };
  }
  async unsubscribe() {
    this.unsubscribed = true;
    if (this.manager.current === this) this.manager.current = null;
    return true;
  }
}

class FakePushManager {
  current: FakeSubscription | null = null;
  subscribed: { userVisibleOnly: true; applicationServerKey: Uint8Array }[] = [];
  failSubscribe: Error | undefined;
  failGet: Error | undefined;
  private next = 0;
  async getSubscription() {
    if (this.failGet) throw this.failGet;
    return this.current;
  }
  async subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }) {
    this.subscribed.push(options);
    if (this.failSubscribe) throw this.failSubscribe;
    const key = btoa(String.fromCharCode(...options.applicationServerKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    this.current = new FakeSubscription(this, `https://push.example/${++this.next}`, key);
    return this.current;
  }
  /** A subscription that already exists in the browser. */
  existing(endpoint = 'https://push.example/old', key: string | null = KEY) {
    this.current = new FakeSubscription(this, endpoint, key);
    return this.current;
  }
}

class FakeNotification {
  requests = 0;
  constructor(
    public permission: Permission = 'default',
    public answer: Permission = 'granted',
  ) {}
  requestPermission() {
    this.requests++;
    this.permission = this.answer;
    return Promise.resolve(this.answer);
  }
}

class FakeClient implements PushClient {
  host: { push: { vapidPublicKey: string; subscribed: boolean } } | undefined;
  readonly calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  readonly failures = new Map<string, unknown>();
  private readonly ready = new Set<() => void>();
  constructor(push?: { vapidPublicKey?: string; subscribed?: boolean }) {
    if (push !== undefined) this.host = { push: { vapidPublicKey: KEY, subscribed: false, ...push } };
  }
  async request(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, params });
    const failure = this.failures.get(method);
    if (failure !== undefined) throw failure;
    return { ok: true };
  }
  on(_event: 'ready', listener: () => void) {
    this.ready.add(listener);
    return () => this.ready.delete(listener);
  }
  /** A (re)connect: the host's initialize result, then ready. */
  connect(push: { vapidPublicKey?: string; subscribed?: boolean } = {}) {
    this.host = { push: { vapidPublicKey: KEY, subscribed: false, ...push } };
    for (const listener of this.ready) listener();
  }
  methods() {
    return this.calls.map((call) => call.method);
  }
  get listeners() {
    return this.ready.size;
  }
}

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

interface Setup {
  notification?: FakeNotification | undefined;
  pushManager?: boolean;
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  client?: FakeClient;
  storage?: MemoryStorage | null;
  noActiveWorker?: boolean;
}

function setup(options: Setup = {}) {
  const manager = new FakePushManager();
  const posted: unknown[] = [];
  const registration = { pushManager: manager, active: options.noActiveWorker ? null : { postMessage: (m: unknown) => posted.push(m) } };
  const workerListeners = new Set<(data: unknown) => void>();
  const notification = 'notification' in options ? options.notification : new FakeNotification();
  const env: PushEnvironment = {
    notification,
    pushManager: options.pushManager ?? true,
    registration: async () => registration,
    userAgent: options.userAgent ?? ANDROID,
    maxTouchPoints: options.maxTouchPoints ?? 5,
    standalone: options.standalone ?? false,
    onWorkerMessage(listener) {
      workerListeners.add(listener);
      return () => workerListeners.delete(listener);
    },
  };
  const client = options.client ?? new FakeClient();
  const storage = options.storage === undefined ? new MemoryStorage() : options.storage;
  const model = new PushModel({ client, env, storage });
  let changes = 0;
  model.subscribe(() => changes++);
  const fromWorker = (data: unknown) => {
    for (const listener of workerListeners) listener(data);
  };
  return { model, client, manager, notification, posted, storage, fromWorker, workerListeners, changes: () => changes };
}

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url without padding into the raw bytes', () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65); // an uncompressed P-256 point
    expect(bytes[0]).toBe(0x04);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]); // the URL-safe characters
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('AQ')]).toEqual([1]);
    expect([...urlBase64ToUint8Array('AQ==')]).toEqual([1]); // tolerates padding
    expect([...urlBase64ToUint8Array('')]).toEqual([]);
  });

  it('refuses standard base64 and other characters', () => {
    expect(() => urlBase64ToUint8Array('a+b/')).toThrow(/base64url/);
    expect(() => urlBase64ToUint8Array('not a key')).toThrow(/base64url/);
  });
});

describe('notificationsHint', () => {
  it("points Home at Settings only while notifications are possible and off", () => {
    expect(notificationsHint({ kind: 'off' })).toBe(NOTIFICATIONS_HINT);
    expect(notificationsHint({ kind: 'needs-install' })).toBe('Turn on notifications in Settings');
    for (const kind of ['on', 'denied', 'unsupported', 'subscribing'] as const) expect(notificationsHint({ kind })).toBeUndefined();
    expect(notificationsHint({ kind: 'error', message: 'x' })).toBeUndefined();
  });
});

describe('isIos', () => {
  it('knows iPhones, iPads and the iPad that says it is a Mac', () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', 0)).toBe(false);
    expect(isIos(ANDROID, 5)).toBe(false);
  });
});

describe('PushModel: what the browser allows', () => {
  it('is unsupported without Notification or without PushManager, and then never listens', () => {
    const noNotification = setup({ notification: undefined });
    expect(noNotification.model.state).toEqual({ kind: 'unsupported' });
    expect(noNotification.client.listeners).toBe(0);
    expect(noNotification.workerListeners.size).toBe(0);
    expect(setup({ pushManager: false }).model.state).toEqual({ kind: 'unsupported' });
  });

  it('needs an install on iOS outside the home-screen app, even where PushManager is missing', () => {
    expect(setup({ userAgent: IPHONE, standalone: false }).model.state).toEqual({ kind: 'needs-install' });
    expect(setup({ userAgent: IPHONE, standalone: false, pushManager: false, notification: undefined }).model.state).toEqual({ kind: 'needs-install' });
    expect(setup({ userAgent: IPHONE, standalone: true }).model.state).toEqual({ kind: 'off' });
  });

  it('turnOn and turnOff do nothing where push is not offered', async () => {
    const { model, client, notification } = setup({ userAgent: IPHONE, standalone: false });
    await model.turnOn();
    await model.turnOff();
    expect(notification!.requests).toBe(0);
    expect(client.calls).toEqual([]);
    expect(model.state).toEqual({ kind: 'needs-install' });
  });

  it('is denied when the user blocked notifications, and follows a re-enable on the next ready', async () => {
    const notification = new FakeNotification('denied');
    const { model, client } = setup({ notification });
    expect(model.state).toEqual({ kind: 'denied' });
    client.connect();
    await flush();
    expect(model.state).toEqual({ kind: 'denied' });
    notification.permission = 'default'; // allowed again in Settings
    client.connect();
    await flush();
    expect(model.state).toEqual({ kind: 'off' });
  });
});

describe('PushModel: turning on', () => {
  it('asks for permission inside the tap, subscribes with the host key, then sends push/subscribe', async () => {
    const client = new FakeClient({ subscribed: false });
    const { model, manager, notification, posted, storage, changes } = setup({ client });
    await flush();
    expect(model.state).toEqual({ kind: 'off' });

    const turning = model.turnOn();
    expect(notification!.requests).toBe(1); // synchronously, before any await
    expect(model.state).toEqual({ kind: 'subscribing' });
    await turning;

    expect(manager.subscribed).toHaveLength(1);
    expect(manager.subscribed[0]!.userVisibleOnly).toBe(true);
    expect([...manager.subscribed[0]!.applicationServerKey]).toEqual([...urlBase64ToUint8Array(KEY)]);
    expect(client.calls).toEqual([{ method: 'push/subscribe', params: { subscription: manager.current!.toJSON() } }]);
    expect(model.state).toEqual({ kind: 'on' });
    expect(posted).toEqual([{ type: 'push-key', key: KEY }]); // the worker can re-subscribe alone
    expect(storage!.getItem(ENDPOINT_STORAGE_KEY)).toBe(manager.current!.endpoint);
    expect(changes()).toBeGreaterThanOrEqual(2);
  });

  it('a refused permission prompt ends in denied, a dismissed one back at off', async () => {
    const refused = setup({ client: new FakeClient({}), notification: new FakeNotification('default', 'denied') });
    await refused.model.turnOn();
    expect(refused.model.state).toEqual({ kind: 'denied' });
    expect(refused.manager.subscribed).toEqual([]);

    const dismissed = setup({ client: new FakeClient({}), notification: new FakeNotification('default', 'default') });
    await dismissed.model.turnOn();
    expect(dismissed.model.state).toEqual({ kind: 'off' });
    expect(dismissed.client.calls).toEqual([]);
  });

  it('errors before the host is known, when the push service refuses, and when the host refuses', async () => {
    const early = setup();
    await early.model.turnOn();
    expect(early.model.state).toEqual({ kind: 'error', message: 'Could not turn on notifications: Not connected to the host yet. Try again in a moment.' });

    const service = setup({ client: new FakeClient({}) });
    service.manager.failSubscribe = new Error('Registration failed - push service error');
    await service.model.turnOn();
    expect(service.model.state).toEqual({ kind: 'error', message: 'Could not turn on notifications: Registration failed - push service error' });
    expect(service.client.calls).toEqual([]);

    const host = setup({ client: new FakeClient({}) });
    host.client.failures.set('push/subscribe', { code: 'invalid_params', message: 'subscription.keys is required' });
    await host.model.turnOn();
    expect(host.model.state).toEqual({ kind: 'error', message: 'Could not turn on notifications: subscription.keys is required' });
    expect(host.storage!.getItem(ENDPOINT_STORAGE_KEY)).toBeNull();

    // From error the switch tries again.
    host.client.failures.clear();
    await host.model.turnOn();
    expect(host.model.state).toEqual({ kind: 'on' });
  });

  it('an error without a message still says something', async () => {
    const { model, manager } = setup({ client: new FakeClient({}) });
    manager.failSubscribe = 'AbortError' as unknown as Error;
    await model.turnOn();
    expect(model.state).toEqual({ kind: 'error', message: 'Could not turn on notifications: AbortError' });
  });

  it('works without storage and without an active worker', async () => {
    const { model, posted } = setup({ client: new FakeClient({}), storage: null, noActiveWorker: true });
    await model.turnOn();
    expect(model.state).toEqual({ kind: 'on' });
    expect(posted).toEqual([]);
  });

  it('a ready that arrives mid-subscribe does not flip the switch back', async () => {
    const { model, client } = setup({ client: new FakeClient({}) });
    const turning = model.turnOn();
    client.connect({ subscribed: false });
    await turning;
    await flush();
    expect(model.state).toEqual({ kind: 'on' });
    expect(client.methods()).toEqual(['push/subscribe']);
  });
});

describe('PushModel: turning off', () => {
  it('unsubscribes in the browser first, then sends push/unsubscribe with the endpoint', async () => {
    const { model, client, manager, storage } = setup({ client: new FakeClient({}) });
    await model.turnOn();
    const subscription = manager.current!;
    await model.turnOff();
    expect(subscription.unsubscribed).toBe(true);
    expect(client.calls.at(-1)).toEqual({ method: 'push/unsubscribe', params: { endpoint: subscription.endpoint } });
    expect(model.state).toEqual({ kind: 'off' });
    expect(storage!.getItem(ENDPOINT_STORAGE_KEY)).toBeNull();
  });

  it('with no browser subscription there is nothing to tell the host', async () => {
    const { model, client } = setup({ client: new FakeClient({}) });
    await model.turnOff();
    expect(model.state).toEqual({ kind: 'off' });
    expect(client.calls).toEqual([]);
  });

  it('says so when the host did not hear it, or when the browser failed', async () => {
    const host = setup({ client: new FakeClient({}) });
    await host.model.turnOn();
    host.client.failures.set('push/unsubscribe', { code: 'timeout', message: 'push/unsubscribe got no response' });
    await host.model.turnOff();
    expect(host.model.state).toEqual({ kind: 'error', message: 'Turned off on this phone, but the host did not hear it: push/unsubscribe got no response' });

    const browser = setup({ client: new FakeClient({}) });
    browser.manager.failGet = new Error('storage error');
    await browser.model.turnOff();
    expect(browser.model.state).toEqual({ kind: 'error', message: 'Could not turn off notifications: storage error' });
  });
});

describe('PushModel: every ready', () => {
  it('reflects the host: on when the browser and the host both have it, off when the browser has none', async () => {
    const client = new FakeClient();
    const { model, manager, storage, posted } = setup({ client, notification: new FakeNotification('granted') });
    manager.existing('https://push.example/old');
    storage!.setItem(ENDPOINT_STORAGE_KEY, 'https://push.example/old');
    client.connect({ subscribed: true });
    await flush();
    expect(model.state).toEqual({ kind: 'on' });
    expect(client.calls).toEqual([]); // nothing to resend
    expect(posted).toEqual([{ type: 'push-key', key: KEY }]);

    manager.current = null; // the browser dropped it
    client.connect({ subscribed: true });
    await flush();
    expect(model.state).toEqual({ kind: 'off' });
  });

  it('starts from the host the client already has', async () => {
    const client = new FakeClient({ subscribed: true });
    const notification = new FakeNotification('granted');
    const manager = new FakePushManager();
    const storage = new MemoryStorage();
    storage.setItem(ENDPOINT_STORAGE_KEY, 'https://push.example/old');
    manager.existing('https://push.example/old');
    const model = new PushModel({
      client,
      storage,
      env: {
        notification,
        pushManager: true,
        registration: async () => ({ pushManager: manager, active: null }),
        userAgent: ANDROID,
        maxTouchPoints: 0,
        standalone: false,
        onWorkerMessage: () => () => {},
      },
    });
    await flush();
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('re-sends push/subscribe when the browser has a subscription the host does not know', async () => {
    const client = new FakeClient();
    const { model, manager } = setup({ client, notification: new FakeNotification('granted') });
    const subscription = manager.existing();
    client.connect({ subscribed: false }); // host reinstalled, or the phone re-paired
    await flush();
    expect(client.calls).toEqual([{ method: 'push/subscribe', params: { subscription: subscription.toJSON() } }]);
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('re-sends when the endpoint the host last heard is not the browser one (rotated while closed)', async () => {
    const client = new FakeClient();
    const { model, manager, storage } = setup({ client, notification: new FakeNotification('granted') });
    storage!.setItem(ENDPOINT_STORAGE_KEY, 'https://push.example/before');
    manager.existing('https://push.example/after');
    client.connect({ subscribed: true });
    await flush();
    expect(client.methods()).toEqual(['push/subscribe']);
    expect(storage!.getItem(ENDPOINT_STORAGE_KEY)).toBe('https://push.example/after');
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('replaces a subscription made for another VAPID key (a reinstalled host has new keys)', async () => {
    const client = new FakeClient();
    const { model, manager } = setup({ client, notification: new FakeNotification('granted') });
    const old = manager.existing('https://push.example/old', OTHER_KEY);
    client.connect({ subscribed: true });
    await flush();
    expect(old.unsubscribed).toBe(true);
    expect([...manager.subscribed[0]!.applicationServerKey]).toEqual([...urlBase64ToUint8Array(KEY)]);
    expect(client.calls).toEqual([{ method: 'push/subscribe', params: { subscription: manager.current!.toJSON() } }]);
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('a stale-key subscription without permission is dropped, not replaced', async () => {
    const client = new FakeClient();
    const { model, manager } = setup({ client, notification: new FakeNotification('default') });
    const old = manager.existing('https://push.example/old', OTHER_KEY);
    client.connect({ subscribed: true });
    await flush();
    expect(old.unsubscribed).toBe(true);
    expect(manager.subscribed).toEqual([]);
    expect(model.state).toEqual({ kind: 'off' });
  });

  it('a subscription without a known key is kept as is', async () => {
    const client = new FakeClient();
    const { model, manager } = setup({ client, notification: new FakeNotification('granted') });
    manager.existing('https://push.example/old', null);
    client.connect({ subscribed: false });
    await flush();
    expect(client.methods()).toEqual(['push/subscribe']);
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('shows the error when checking fails, and a user action wins over a late check', async () => {
    const client = new FakeClient();
    const { model, manager } = setup({ client, notification: new FakeNotification('granted') });
    manager.existing();
    client.failures.set('push/subscribe', { code: 'internal', message: 'database is locked' });
    client.connect({ subscribed: false });
    await flush();
    expect(model.state).toEqual({ kind: 'error', message: 'Could not check notifications: database is locked' });

    client.failures.clear();
    client.connect({ subscribed: false });
    const off = model.turnOff(); // while that check is in flight
    await off;
    await flush();
    expect(model.state).toEqual({ kind: 'off' });
  });

  it('the worker re-subscribed on its own: the page tells the host the new endpoint', async () => {
    const client = new FakeClient();
    const { model, manager, storage, fromWorker } = setup({ client, notification: new FakeNotification('granted') });
    manager.existing('https://push.example/old');
    storage!.setItem(ENDPOINT_STORAGE_KEY, 'https://push.example/old');
    client.connect({ subscribed: true });
    await flush();
    expect(client.calls).toEqual([]);

    manager.existing('https://push.example/new'); // what pushsubscriptionchange did
    fromWorker({ type: 'other' });
    fromWorker(null);
    await flush();
    expect(client.calls).toEqual([]);
    fromWorker({ type: 'pushsubscriptionchange' });
    await flush();
    expect(client.calls).toEqual([{ method: 'push/subscribe', params: { subscription: manager.current!.toJSON() } }]);
    expect(model.state).toEqual({ kind: 'on' });
  });

  it('dispose stops listening', async () => {
    const client = new FakeClient();
    const { model, workerListeners } = setup({ client });
    model.dispose();
    expect(client.listeners).toBe(0);
    expect(workerListeners.size).toBe(0);
  });
});

describe('PushModel: Send test notification', () => {
  it('calls push/test and says it was sent', async () => {
    const { model, client } = setup({ client: new FakeClient({}) });
    const sending = model.sendTest();
    expect(model.test).toEqual({ kind: 'sending' });
    await model.sendTest(); // a second tap while sending is ignored
    await sending;
    expect(client.calls).toEqual([{ method: 'push/test', params: {} }]);
    expect(model.test).toEqual({ kind: 'sent' });
  });

  it('shows the host refusal in words', async () => {
    const { model, client } = setup({ client: new FakeClient({}) });
    client.failures.set('push/test', { code: 'not_found', message: 'no subscription', data: { reason: 'no_subscription' } });
    await model.sendTest();
    expect(model.test).toEqual({ kind: 'failed', message: 'The host has no subscription for this phone. Turn notifications off and on again.' });
  });

  it('testErrorText covers every spec 9 reason and falls back to the message', () => {
    expect(testErrorText({ code: 'not_found', data: { reason: 'subscription_expired' } })).toBe('The subscription expired. Turn notifications off and on again.');
    expect(testErrorText({ code: 'internal', data: { reason: 'push_failed', status: 403 } })).toBe('The push service refused the message (HTTP 403).');
    expect(testErrorText({ code: 'internal', data: { reason: 'push_failed' } })).toBe('The push service refused the message.');
    expect(testErrorText({ code: 'internal', data: { reason: 'timeout' } })).toBe('The push service did not answer in time.');
    expect(testErrorText({ code: 'internal', data: { reason: 'network' } })).toBe('The host could not reach the push service.');
    expect(testErrorText({ code: 'timeout', message: 'push/test got no response' })).toBe('push/test got no response');
    expect(testErrorText(null)).toBe('null');
  });
});

describe('browserPushEnvironment', () => {
  function fakeWindow(overrides: Partial<PushWindow> = {}, navigator: Partial<PushWindow['navigator']> = {}): PushWindow {
    return { Notification: new FakeNotification(), PushManager: function PushManager() {}, navigator: { userAgent: ANDROID, ...navigator }, ...overrides };
  }

  it('reads the browser: Notification, PushManager with a service worker, standalone either way', async () => {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const registration = { pushManager: new FakePushManager(), active: null };
    const serviceWorker = {
      ready: Promise.resolve(registration),
      addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void) => listeners.add(listener),
      removeEventListener: (_type: 'message', listener: (event: { data: unknown }) => void) => listeners.delete(listener),
    };
    const win = fakeWindow({ matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }) }, { serviceWorker, maxTouchPoints: 5 });
    const env = browserPushEnvironment(win);
    expect(env.notification).toBe(win.Notification);
    expect(env.pushManager).toBe(true);
    expect(env.standalone).toBe(true);
    expect(env.maxTouchPoints).toBe(5);
    expect(env.userAgent).toBe(ANDROID);
    expect(await env.registration()).toBe(registration);

    const heard: unknown[] = [];
    const off = env.onWorkerMessage((data) => heard.push(data));
    for (const listener of listeners) listener({ data: { type: 'pushsubscriptionchange' } });
    off();
    expect(listeners.size).toBe(0);
    expect(heard).toEqual([{ type: 'pushsubscriptionchange' }]);

    expect(browserPushEnvironment(fakeWindow({}, { standalone: true, serviceWorker })).standalone).toBe(true); // iOS
  });

  it('without a service worker there is no push, and nothing to listen to', async () => {
    const env = browserPushEnvironment(fakeWindow({ PushManager: undefined, Notification: undefined }));
    expect(env.pushManager).toBe(false);
    expect(env.notification).toBeUndefined();
    expect(env.standalone).toBe(false);
    expect(env.maxTouchPoints).toBe(0);
    await expect(env.registration()).rejects.toThrow('no service worker');
    expect(env.onWorkerMessage(() => {})).toBeTypeOf('function');
    env.onWorkerMessage(() => {})();
  });
});
