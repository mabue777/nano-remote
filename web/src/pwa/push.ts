// Web Push on the phone (spec 9, ADR 0005): the Notifications toggle's model. It asks for permission
// from the tap, subscribes through the service worker's PushManager with the host's VAPID key, and
// tells the host with push/subscribe. Every browser API it touches comes in through PushEnvironment, so
// the tests drive it with fakes; browserPushEnvironment() builds the real one.
//
// On every `ready` (each reconnect) the toggle follows the host's `push.subscribed`, and a subscription
// the host does not know (host reinstalled, device re-paired, or the push service rotated it while the
// app was closed) is sent again. A subscription made for another VAPID key (a reinstalled host has new
// keys) is replaced, since the push service would reject the host's messages for it.
import type { StorageLike } from '../replica/storage';

/** What the card shows. Only `off`, `on` and `error` offer the switch. */
export type PushState =
  /** No PushManager or no Notification in this browser (Brave tabs, old browsers, the dev server). */
  | { kind: 'unsupported' }
  /** iOS in a Safari tab: Web Push only reaches a home-screen install. */
  | { kind: 'needs-install' }
  /** The user blocked notifications; only the system or browser settings can undo that. */
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'subscribing' }
  | { kind: 'on' }
  | { kind: 'error'; message: string };

/** The Send test notification button. */
export type TestState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; message: string };

export type Permission = 'default' | 'granted' | 'denied';

/** PushSubscription.toJSON(): the spec's PushSubscription shape. */
export interface SubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface SubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<SubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
}

export interface PushRegistrationLike {
  readonly pushManager: PushManagerLike;
  /** The active worker, told the VAPID key so pushsubscriptionchange can subscribe again. */
  readonly active: { postMessage(message: unknown): void } | null;
}

export interface NotificationLike {
  readonly permission: Permission;
  requestPermission(): Promise<Permission>;
}

export interface PushEnvironment {
  /** undefined when the browser has no Notification. */
  notification: NotificationLike | undefined;
  /** False when the browser has no PushManager or no service worker. */
  pushManager: boolean;
  /** The service worker registration (navigator.serviceWorker.ready). */
  registration(): Promise<PushRegistrationLike>;
  userAgent: string;
  maxTouchPoints: number;
  /** display-mode standalone or navigator.standalone: launched from the home screen. */
  standalone: boolean;
  /** Messages from the service worker (navigator.serviceWorker 'message'). */
  onWorkerMessage(listener: (data: unknown) => void): () => void;
}

/** The slice of StreamClient this model uses. */
export interface PushClient {
  readonly host: { push: { vapidPublicKey: string; subscribed: boolean } } | undefined;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'ready', listener: () => void): () => void;
}

/** What `push/*` failures carry (RequestError from the stream client). */
interface ErrorLike {
  code?: unknown;
  message?: unknown;
  data?: { reason?: unknown; status?: unknown };
}

/** The message the service worker posts after it re-subscribed on pushsubscriptionchange. */
export const SUBSCRIPTION_CHANGED = 'pushsubscriptionchange';
/** The message the page posts so the worker can subscribe again without the page. */
export const PUSH_KEY_MESSAGE = 'push-key';

/** A VAPID public key (base64url, no padding) as the bytes PushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(base64url)) throw new Error('VAPID key is not base64url');
  const base64 = base64url.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** iPhone, iPod, or an iPad (which reports itself as a Mac with a touch screen). */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function messageOf(error: unknown): string {
  const message = (error as ErrorLike | null)?.message;
  return typeof message === 'string' && message !== '' ? message : String(error);
}

/** The words for a refused push/test (spec 9 lists the reasons). */
export function testErrorText(error: unknown): string {
  const { code, data } = (error ?? {}) as ErrorLike;
  const reason = data?.reason;
  if (code === 'not_found' && reason === 'no_subscription') return 'The host has no subscription for this phone. Turn notifications off and on again.';
  if (code === 'not_found' && reason === 'subscription_expired') return 'The subscription expired. Turn notifications off and on again.';
  if (reason === 'push_failed') return `The push service refused the message${typeof data?.status === 'number' ? ` (HTTP ${data.status})` : ''}.`;
  if (reason === 'timeout') return 'The push service did not answer in time.';
  if (reason === 'network') return 'The host could not reach the push service.';
  return messageOf(error);
}

export interface PushModelOptions {
  client: PushClient;
  env: PushEnvironment;
  /** Remembers the endpoint the host last heard, so a rotated one is sent again on the next start. */
  storage?: StorageLike | null;
}

export const ENDPOINT_STORAGE_KEY = 'nano-remote/push/endpoint';

export class PushModel {
  private stateValue: PushState;
  private testValue: TestState = { kind: 'idle' };
  private versionValue = 0;
  private readonly listeners = new Set<() => void>();
  private readonly cleanup: (() => void)[] = [];
  /** Bumped by every user action, so a sync that finishes late does not undo it. */
  private generation = 0;

  constructor(private readonly options: PushModelOptions) {
    const { env } = options;
    if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone) this.stateValue = { kind: 'needs-install' };
    else if (env.notification === undefined || !env.pushManager) this.stateValue = { kind: 'unsupported' };
    else if (env.notification.permission === 'denied') this.stateValue = { kind: 'denied' };
    else this.stateValue = { kind: 'off' };
    if (!this.active) return;
    this.cleanup.push(
      options.client.on('ready', () => void this.sync()),
      env.onWorkerMessage((data) => {
        if ((data as { type?: unknown } | null)?.type === SUBSCRIPTION_CHANGED) void this.sync(true);
      }),
    );
    if (options.client.host !== undefined) void this.sync();
  }

  /** Bumped on every change, so a view that subscribes late can tell it missed one (useModel). */
  get version(): number {
    return this.versionValue;
  }

  get state(): PushState {
    return this.stateValue;
  }

  get test(): TestState {
    return this.testValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    this.listeners.clear();
  }

  /**
   * The switch was turned on. Call it straight from the tap handler: iOS grants permission only inside
   * a user gesture, so requestPermission runs before anything is awaited.
   */
  async turnOn(): Promise<void> {
    const { env, client } = this.options;
    if (!this.active || env.notification === undefined) return;
    const generation = ++this.generation;
    const permission = env.notification.requestPermission();
    this.set({ kind: 'subscribing' });
    try {
      const answer = await permission;
      if (answer === 'denied') return this.set({ kind: 'denied' });
      if (answer !== 'granted') return this.set({ kind: 'off' }); // dismissed
      const push = client.host?.push;
      if (push === undefined) throw new Error('Not connected to the host yet. Try again in a moment.');
      const registration = await env.registration();
      const subscription = await this.subscribeWith(registration, push.vapidPublicKey);
      await this.tellHost(subscription);
      if (generation === this.generation) this.set({ kind: 'on' });
    } catch (error) {
      if (generation === this.generation) this.set({ kind: 'error', message: `Could not turn on notifications: ${messageOf(error)}` });
    }
  }

  /** The switch was turned off: drop the browser's subscription, then tell the host. */
  async turnOff(): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    let endpoint: string | undefined;
    try {
      const registration = await this.options.env.registration();
      const subscription = await registration.pushManager.getSubscription();
      endpoint = subscription?.endpoint;
      await subscription?.unsubscribe();
      this.options.storage?.removeItem(ENDPOINT_STORAGE_KEY);
      if (generation === this.generation) this.set({ kind: 'off' });
      if (endpoint !== undefined) await this.options.client.request('push/unsubscribe', { endpoint });
    } catch (error) {
      if (generation === this.generation) {
        const where = endpoint === undefined ? 'Could not turn off notifications' : 'Turned off on this phone, but the host did not hear it';
        this.set({ kind: 'error', message: `${where}: ${messageOf(error)}` });
      }
    }
  }

  /** Asks the host to send one notification now. */
  async sendTest(): Promise<void> {
    if (this.testValue.kind === 'sending') return;
    this.setTest({ kind: 'sending' });
    try {
      await this.options.client.request('push/test', {});
      this.setTest({ kind: 'sent' });
    } catch (error) {
      this.setTest({ kind: 'failed', message: testErrorText(error) });
    }
  }

  /** Can this browser get pushes at all (the switch is offered)? */
  private get active(): boolean {
    return this.stateValue.kind !== 'unsupported' && this.stateValue.kind !== 'needs-install';
  }

  /**
   * Brings the switch in line with the host and the browser. `rotated`: the service worker subscribed
   * again on its own, so the host must hear the new endpoint even though it says subscribed.
   */
  private async sync(rotated = false): Promise<void> {
    const { env, client } = this.options;
    const push = client.host?.push;
    if (push === undefined || env.notification === undefined) return;
    if (this.stateValue.kind === 'subscribing') return; // turnOn finishes the job
    const generation = this.generation;
    const permission = env.notification.permission;
    if (permission === 'denied') return this.set({ kind: 'denied' });
    if (this.stateValue.kind === 'denied') this.set({ kind: 'off' }); // re-enabled in Settings
    try {
      const registration = await env.registration();
      let subscription = await registration.pushManager.getSubscription();
      const wanted = urlBase64ToUint8Array(push.vapidPublicKey);
      const key = subscription?.options?.applicationServerKey;
      const staleKey = subscription !== null && key !== undefined && key !== null && !sameBytes(new Uint8Array(key), wanted);
      if (subscription !== null && staleKey) {
        await subscription.unsubscribe();
        subscription = permission === 'granted' ? await this.subscribeWith(registration, push.vapidPublicKey) : null;
      }
      if (generation !== this.generation) return;
      if (subscription === null || permission !== 'granted') return this.set({ kind: 'off' });
      if (!push.subscribed || staleKey || rotated || this.sentEndpoint !== subscription.endpoint) {
        await this.tellHost(subscription);
      } else {
        registration.active?.postMessage({ type: PUSH_KEY_MESSAGE, key: push.vapidPublicKey });
      }
      if (generation === this.generation) this.set({ kind: 'on' });
    } catch (error) {
      if (generation === this.generation) this.set({ kind: 'error', message: `Could not check notifications: ${messageOf(error)}` });
    }
  }

  private get sentEndpoint(): string | null {
    return this.options.storage?.getItem(ENDPOINT_STORAGE_KEY) ?? null;
  }

  private async tellHost(subscription: SubscriptionLike): Promise<void> {
    await this.options.client.request('push/subscribe', { subscription: subscription.toJSON() as SubscriptionJson });
    this.options.storage?.setItem(ENDPOINT_STORAGE_KEY, subscription.endpoint);
  }

  private async subscribeWith(registration: PushRegistrationLike, vapidPublicKey: string): Promise<SubscriptionLike> {
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
    registration.active?.postMessage({ type: PUSH_KEY_MESSAGE, key: vapidPublicKey });
    return subscription;
  }

  private set(state: PushState): void {
    this.stateValue = state;
    this.changed();
  }

  private setTest(state: TestState): void {
    this.testValue = state;
    this.changed();
  }

  private changed(): void {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The parts of `window` browserPushEnvironment reads; a fake in tests. */
export interface PushWindow {
  Notification?: NotificationLike;
  PushManager?: unknown;
  navigator: {
    userAgent: string;
    maxTouchPoints?: number;
    standalone?: boolean;
    serviceWorker?: {
      ready: Promise<PushRegistrationLike>;
      addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
      removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    };
  };
  matchMedia?(query: string): { matches: boolean };
}

export function browserPushEnvironment(win: PushWindow): PushEnvironment {
  const worker = win.navigator.serviceWorker;
  return {
    notification: win.Notification,
    pushManager: win.PushManager !== undefined && worker !== undefined,
    registration: () => (worker === undefined ? Promise.reject(new Error('no service worker')) : worker.ready),
    userAgent: win.navigator.userAgent,
    maxTouchPoints: win.navigator.maxTouchPoints ?? 0,
    standalone: win.navigator.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true,
    onWorkerMessage(listener) {
      if (worker === undefined) return () => {};
      const handler = (event: { data: unknown }) => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
  };
}
