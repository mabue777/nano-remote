// The "new version" prompt: shown once a new build's service worker is waiting. Reload activates it.
import { useEffect, useState } from 'preact/hooks';

import { watchForUpdates, type WorkerContainer } from './update';

/** Update state the prompt renders; `available` flips to true once and stays. */
export interface UpdateSignal {
  readonly available: boolean;
  subscribe(listener: () => void): () => void;
  apply(): void;
}

/** Registers the service worker; checks for a new build whenever the app comes back to the foreground. */
export function startUpdates(container: WorkerContainer, doc: Document, reload: () => void): UpdateSignal {
  const listeners = new Set<() => void>();
  let available = false;
  const watch = watchForUpdates({
    container,
    reload,
    onUpdateReady: () => {
      available = true;
      for (const listener of listeners) listener();
    },
  });
  watch.ready.catch((error: unknown) => console.warn('service worker registration failed', error));
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') watch.checkForUpdate();
  });
  return {
    get available() {
      return available;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: () => watch.applyUpdate(),
  };
}

export function UpdatePrompt({ updates }: { updates: UpdateSignal }) {
  const [available, setAvailable] = useState(updates.available);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    setAvailable(updates.available);
    return updates.subscribe(() => setAvailable(updates.available));
  }, [updates]);
  if (!available) return null;
  return (
    <div class="update-prompt" role="alertdialog" aria-label="New version">
      <span>A new version of Nano Remote is ready.</span>
      <button
        type="button"
        class="primary small"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          updates.apply();
        }}
      >
        Reload
      </button>
    </div>
  );
}
