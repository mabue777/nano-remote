// Registers /sw.js (written by web/build/pwa.ts) and tells the page when a new build is waiting.
// The worker never activates itself: the page shows a reload prompt, and accepting it posts
// SKIP_WAITING; the page then reloads once onto the new build.
//
// Reload must always end in a reload, never in a dead greyed button (iPhone report 2026-10-25: the tap
// greyed the button and nothing else happened). So applying an update:
// - posts SKIP_WAITING to the worker that is waiting at tap time (registration.waiting), not only the one
//   remembered from the prompt, which a newer build may have replaced (it is redundant then);
// - posts it as well to any newer build that finishes installing while the update is being applied;
// - reloads on the first of: the controller changes, the target worker reaches 'activated' or
//   'redundant', or RELOAD_FALLBACK_MS pass. Navigations are network first (service-worker.js), so even
//   the fallback reload loads the newest index.html and its assets.

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
  /** Activates the newest waiting build and reloads onto it (at the latest after RELOAD_FALLBACK_MS). */
  applyUpdate(): void;
  /** Asks the host whether sw.js changed (a standalone app can stay open for days). */
  checkForUpdate(): void;
}

export interface WatchOptions {
  container: WorkerContainer;
  onUpdateReady: () => void;
  reload: () => void;
  url?: string;
  /** setTimeout by default; injected in tests. */
  setTimer?: (callback: () => void, ms: number) => void;
}

export const SERVICE_WORKER_URL = '/sw.js';
/** How long Reload waits for the new worker to take over before reloading anyway. */
export const RELOAD_FALLBACK_MS = 1500;
const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;

export function watchForUpdates({
  container,
  onUpdateReady,
  reload,
  url = SERVICE_WORKER_URL,
  setTimer = (callback, ms) => void setTimeout(callback, ms),
}: WatchOptions): UpdateWatch {
  let waiting: WorkerLike | null = null;
  let registration: RegistrationLike | null = null;
  let applying = false;
  let reloaded = false;
  // The first install on a fresh page is not an update: there was no controller to replace.
  const hadController = () => container.controller !== null && container.controller !== undefined;

  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };
  /** Tells `worker` to take over, and reloads once it has (or once it was replaced by a newer one). */
  const activate = (worker: WorkerLike) => {
    const settled = () => worker.state === 'activated' || worker.state === 'redundant';
    if (settled()) return reloadOnce(); // another tab already activated it
    worker.addEventListener('statechange', () => {
      if (settled()) reloadOnce();
    });
    worker.postMessage(SKIP_WAITING);
  };
  const offer = (worker: WorkerLike) => {
    waiting = worker;
    if (applying) activate(worker); // a newer build landed while Reload was in flight
    else onUpdateReady();
  };
  const track = (worker: WorkerLike | null) => {
    if (worker === null) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && hadController()) offer(worker);
    });
  };

  container.addEventListener('controllerchange', () => {
    if (applying) reloadOnce();
  });

  const ready = container.register(url, { scope: '/' }).then((found) => {
    registration = found;
    if (found.waiting !== null && hadController()) offer(found.waiting);
    track(found.installing);
    found.addEventListener('updatefound', () => track(found.installing));
    return found;
  });

  return {
    ready,
    applyUpdate() {
      if (applying) return;
      applying = true;
      const target = registration?.waiting ?? waiting;
      if (target === null) return reloadOnce(); // nothing left to activate: another tab already did
      activate(target);
      if (!reloaded) setTimer(reloadOnce, RELOAD_FALLBACK_MS);
    },
    checkForUpdate() {
      void ready.then((found) => found.update()).catch(() => {});
    },
  };
}
