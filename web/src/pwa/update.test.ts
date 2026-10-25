import { describe, expect, it, vi } from 'vitest';

import { RELOAD_FALLBACK_MS, watchForUpdates, type RegistrationLike, type WorkerContainer, type WorkerLike } from './update';

class FakeWorker implements WorkerLike {
  state = 'installing';
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  addEventListener(_type: 'statechange', listener: () => void) {
    this.listeners.push(listener);
  }
  become(state: string) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeRegistration implements RegistrationLike {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  private listeners: (() => void)[] = [];
  addEventListener(_type: 'updatefound', listener: () => void) {
    this.listeners.push(listener);
  }
  async update() {
    this.updates++;
  }
  found(worker: FakeWorker) {
    this.installing = worker;
    for (const listener of this.listeners) listener();
  }
}

class FakeContainer implements WorkerContainer {
  controller: unknown = null;
  registered: { url: string; options?: { scope?: string } }[] = [];
  private listeners: (() => void)[] = [];
  constructor(readonly registration = new FakeRegistration()) {}
  async register(url: string, options?: { scope?: string }) {
    this.registered.push({ url, options });
    return this.registration;
  }
  addEventListener(_type: 'controllerchange', listener: () => void) {
    this.listeners.push(listener);
  }
  changeController() {
    this.controller = {};
    for (const listener of this.listeners) listener();
  }
}

function setup(controlled: boolean) {
  const container = new FakeContainer();
  if (controlled) container.controller = {};
  const onUpdateReady = vi.fn();
  const reload = vi.fn();
  const timers: { callback: () => void; ms: number }[] = [];
  const watch = watchForUpdates({ container, onUpdateReady, reload, setTimer: (callback, ms) => void timers.push({ callback, ms }) });
  return { container, registration: container.registration, watch, onUpdateReady, reload, timers };
}

/** A controlled page with build B installed and offered by the prompt. */
async function offered() {
  const env = setup(true);
  await env.watch.ready;
  const b = new FakeWorker();
  env.registration.found(b);
  b.become('installed');
  env.registration.installing = null;
  env.registration.waiting = b;
  return { ...env, b };
}

describe('watchForUpdates', () => {
  it('registers /sw.js for the whole origin', async () => {
    const { container, watch } = setup(false);
    await watch.ready;
    expect(container.registered).toEqual([{ url: '/sw.js', options: { scope: '/' } }]);
  });

  it('a first install is not an update: no prompt and no reload when the worker claims the page', async () => {
    const { container, registration, watch, onUpdateReady, reload } = setup(false);
    await watch.ready;
    const worker = new FakeWorker();
    registration.found(worker);
    worker.become('installed');
    worker.become('activated');
    container.changeController();
    expect(onUpdateReady).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a new build installed under a controlled page prompts; Reload sends SKIP_WAITING and reloads once on takeover', async () => {
    const { container, watch, onUpdateReady, reload, timers, b } = await offered();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.applyUpdate();
    watch.applyUpdate(); // a second tap while applying changes nothing
    expect(b.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    container.changeController();
    container.changeController();
    b.become('activated');
    timers.forEach((timer) => timer.callback());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Failure mode (a): the worker the prompt remembered was replaced by a newer build whose install the
  // page never saw (e.g. it finished while the phone had the app in the background); a message to the
  // redundant worker goes nowhere.
  it('Reload activates the worker waiting at tap time, not a stale remembered one', async () => {
    const { registration, watch, b } = await offered();
    const c = new FakeWorker();
    c.state = 'installed';
    registration.waiting = c;
    b.state = 'redundant';
    watch.applyUpdate();
    expect(c.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(b.messages).toEqual([]);
  });

  it('a newer build that installs while Reload is in flight is activated too, without a second prompt', async () => {
    const { container, registration, watch, onUpdateReady, reload, b } = await offered();
    watch.applyUpdate();
    const c = new FakeWorker();
    registration.found(c);
    c.become('installed');
    expect(c.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    b.become('redundant'); // C replaced B: reload, the network-first navigation brings the newest page
    container.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Failure mode (b): the new worker takes over but the page never hears controllerchange.
  it('reloads when the new worker reaches activated even without controllerchange', async () => {
    const { watch, reload, b } = await offered();
    watch.applyUpdate();
    b.become('activating');
    expect(reload).not.toHaveBeenCalled();
    b.become('activated');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Failure modes (b) and (c): nothing at all comes back; Reload must not leave a dead greyed button.
  it('reloads anyway after the fallback delay when the worker never takes over', async () => {
    const { watch, reload, timers, b } = await offered();
    watch.applyUpdate();
    expect(b.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(reload).not.toHaveBeenCalled();
    expect(timers.map((timer) => timer.ms)).toEqual([RELOAD_FALLBACK_MS]);
    expect(RELOAD_FALLBACK_MS).toBeLessThanOrEqual(2000);
    timers[0]!.callback();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads straight away when another tab already activated the offered build', async () => {
    const { registration, watch, reload, timers, b } = await offered();
    registration.waiting = null;
    b.state = 'activated';
    watch.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(b.messages).toEqual([]);
    expect(timers).toHaveLength(0);
  });

  it('Reload before any build was offered just reloads', async () => {
    const { watch, reload, timers } = setup(true);
    await watch.ready;
    watch.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
  });

  it('the fallback timer defaults to setTimeout', async () => {
    vi.useFakeTimers();
    try {
      const container = new FakeContainer();
      container.controller = {};
      container.registration.waiting = new FakeWorker();
      const reload = vi.fn();
      const watch = watchForUpdates({ container, onUpdateReady: vi.fn(), reload });
      await watch.ready;
      watch.applyUpdate();
      vi.advanceTimersByTime(RELOAD_FALLBACK_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a build already waiting at page load prompts straight away', async () => {
    const container = new FakeContainer();
    container.controller = {};
    container.registration.waiting = new FakeWorker();
    const onUpdateReady = vi.fn();
    await watchForUpdates({ container, onUpdateReady, reload: vi.fn() }).ready;
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('a worker already installing at registration is tracked too', async () => {
    const container = new FakeContainer();
    container.controller = {};
    const worker = new FakeWorker();
    container.registration.installing = worker;
    const onUpdateReady = vi.fn();
    await watchForUpdates({ container, onUpdateReady, reload: vi.fn() }).ready;
    worker.become('installed');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('another tab taking over does not reload this page unasked', async () => {
    const { container, watch, reload } = setup(true);
    await watch.ready;
    container.changeController();
    expect(reload).not.toHaveBeenCalled();
  });

  it('checkForUpdate asks the registration, and swallows a failed registration', async () => {
    const { registration, watch } = setup(true);
    watch.checkForUpdate();
    await watch.ready;
    await Promise.resolve();
    expect(registration.updates).toBe(1);

    const broken: WorkerContainer = { controller: null, register: () => Promise.reject(new Error('blocked')), addEventListener: () => {} };
    const failing = watchForUpdates({ container: broken, onUpdateReady: vi.fn(), reload: vi.fn() });
    failing.checkForUpdate();
    await expect(failing.ready).rejects.toThrow('blocked');
  });
});
