// Page lifecycle as the stream client needs it: presence for pings (spec 2.2), pagehide to say
// `client_closed {reason: background}`, and pageshow to come back. Injected so tests run in Node.
import type { Presence } from './envelope-stream';

export interface LifecycleHandlers {
  visibility: (state: Presence) => void;
  pagehide: () => void;
  pageshow: () => void;
}

export interface Lifecycle {
  presence(): Presence;
  /** Starts delivering events; returns the function that stops them. */
  subscribe(handlers: LifecycleHandlers): () => void;
}

interface EventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface DocumentLike extends EventSource {
  visibilityState: string;
}

/** The real page: `document.visibilityState` and the window's pagehide and pageshow events. */
export function browserLifecycle(
  doc: DocumentLike | undefined = (globalThis as { document?: DocumentLike }).document,
  win: EventSource | undefined = (globalThis as { window?: EventSource }).window,
): Lifecycle {
  const presence = (): Presence => (doc === undefined || doc.visibilityState !== 'hidden' ? 'foreground' : 'background');
  return {
    presence,
    subscribe(handlers) {
      const onVisibility = () => handlers.visibility(presence());
      const onHide = () => handlers.pagehide();
      const onShow = () => handlers.pageshow();
      doc?.addEventListener('visibilitychange', onVisibility);
      win?.addEventListener('pagehide', onHide);
      win?.addEventListener('pageshow', onShow);
      return () => {
        doc?.removeEventListener('visibilitychange', onVisibility);
        win?.removeEventListener('pagehide', onHide);
        win?.removeEventListener('pageshow', onShow);
      };
    },
  };
}
