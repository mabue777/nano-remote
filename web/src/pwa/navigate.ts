// A tapped notification (web/build/service-worker.js notificationclick) focuses an open window and
// posts {type: 'navigate', url}; this routes the page there. Only same-origin URLs are followed.

/** The message the service worker posts when a notification is tapped while a window is open. */
export const NAVIGATE_MESSAGE = 'navigate';

/** The in-app path a navigate message asks for, or undefined when it is not one to follow. */
export function navigateTarget(data: unknown, origin: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== NAVIGATE_MESSAGE || typeof url !== 'string') return undefined;
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return undefined;
  }
  if (target.origin !== new URL(origin).origin) return undefined;
  return target.pathname + target.search + target.hash;
}

export interface MessageSource {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Routes every navigate message from the service worker; returns the unsubscribe. */
export function listenForNavigate(source: MessageSource, origin: string, navigate: (path: string) => void): () => void {
  const listener = (event: { data: unknown }) => {
    const path = navigateTarget(event.data, origin);
    if (path !== undefined) navigate(path);
  };
  source.addEventListener('message', listener);
  return () => source.removeEventListener('message', listener);
}
