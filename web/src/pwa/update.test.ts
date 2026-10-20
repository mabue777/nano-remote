import { describe, expect, it, vi } from 'vitest';

import { watchForUpdates, type RegistrationLike, type WorkerContainer, type WorkerLike } from './update';

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
  const watch = watchForUpdates({ container, onUpdateReady, reload });
  return { container, registration: container.registration, watch, onUpdateReady, reload };
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
    const { container, registration, watch, onUpdateReady, reload } = setup(true);
    await watch.ready;
    watch.applyUpdate(); // nothing waiting yet: a no-op
    const worker = new FakeWorker();
    registration.found(worker);
    worker.become('installed');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.applyUpdate();
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    container.changeController();
    container.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
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
