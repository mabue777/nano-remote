// Registers /sw.js (written by web/build/pwa.ts) and tells the page when a new build is waiting.
// The worker never activates itself: the page shows a reload prompt, and accepting it posts
// SKIP_WAITING; when the new worker takes control the page reloads once onto the new build.

/** The slice of ServiceWorkerContainer this module uses (a fake in tests). */
export interface WorkerContainer {
  readonly controller: unknown;
  register(url: string, options?: { scope?: string }): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

export interface UpdateWatch {
  /** Resolves once the registration exists (or rejects when registering failed). */
  readonly ready: Promise<RegistrationLike>;
  /** Activates the waiting build; the page reloads when it takes control. */
  applyUpdate(): void;
  /** Asks the host whether sw.js changed (a standalone app can stay open for days). */
  checkForUpdate(): void;
}

export interface WatchOptions {
  container: WorkerContainer;
  onUpdateReady: () => void;
  reload: () => void;
  url?: string;
}

export const SERVICE_WORKER_URL = '/sw.js';

export function watchForUpdates({ container, onUpdateReady, reload, url = SERVICE_WORKER_URL }: WatchOptions): UpdateWatch {
  let waiting: WorkerLike | null = null;
  let applying = false;
  // The first install on a fresh page is not an update: there was no controller to replace.
  const hadController = () => container.controller !== null && container.controller !== undefined;

  const offer = (worker: WorkerLike) => {
    waiting = worker;
    onUpdateReady();
  };
  const track = (worker: WorkerLike | null) => {
    if (worker === null) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && hadController()) offer(worker);
    });
  };

  container.addEventListener('controllerchange', () => {
    if (!applying) return;
    applying = false;
    reload();
  });

  const ready = container.register(url, { scope: '/' }).then((registration) => {
    if (registration.waiting !== null && hadController()) offer(registration.waiting);
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration.installing));
    return registration;
  });

  return {
    ready,
    applyUpdate() {
      if (waiting === null) return;
      applying = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    },
    checkForUpdate() {
      void ready.then((registration) => registration.update()).catch(() => {});
    },
  };
}
