// The app icon badge: how many requests wait for this user across the session list (approvals plus
// questions). Set with navigator.setAppBadge(n), cleared with navigator.clearAppBadge() at 0. Browsers
// without the Badging API (Firefox, Safari tabs) are a no-op, and a refused call (no permission, not
// installed) is swallowed: the badge is a hint, never a reason for the app to fail.
//
// Recomputed whenever the Replica changes (session/list, session/updated, and every Journal event of the
// open session), on approval/request, input/request and request/resolved as the stream delivers them, and
// when the page becomes visible again (the badge may have been changed meanwhile, so that one re-applies
// even when the count did not change).
import type { SessionSummary } from '../replica/types';

/** The two Badging API calls; Navigator fits (both optional where the API is missing). */
export interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** Sum of pending approvals and questions over the session list. */
export function badgeCount(sessions: readonly Pick<SessionSummary, 'pending'>[]): number {
  let total = 0;
  for (const { pending } of sessions) {
    const approvals = Number.isFinite(pending?.approvals) ? Math.max(0, pending.approvals) : 0;
    const inputs = Number.isFinite(pending?.inputs) ? Math.max(0, pending.inputs) : 0;
    total += approvals + inputs;
  }
  return total;
}

/** Sets (count > 0) or clears (0) the badge. False when the API is missing or the call failed. */
export function applyBadge(nav: BadgeNavigator | undefined, count: number): boolean {
  try {
    const call = count > 0 ? nav?.setAppBadge?.bind(nav, count) : nav?.clearAppBadge?.bind(nav);
    if (call === undefined) return false;
    const result = call();
    // A rejected promise must not surface as an unhandled rejection.
    if (result !== undefined && typeof (result as Promise<void>).catch === 'function') void (result as Promise<void>).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** What the badge needs from the Replica and the stream client; Replica and StreamClient fit. */
export interface BadgeReplica {
  readonly sessions: readonly Pick<SessionSummary, 'pending'>[];
  subscribe(listener: () => void): () => void;
}

export interface BadgeClient {
  onNotification(method: string, handler: (params: Record<string, unknown>, method: string) => void): () => void;
}

/** The page's visibility; Document fits. */
export interface BadgeDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface BadgeOptions {
  replica: BadgeReplica;
  client?: BadgeClient;
  nav?: BadgeNavigator;
  doc?: BadgeDocument;
}

/** The request events that change a count. */
export const BADGE_EVENTS = ['approval/request', 'input/request', 'request/resolved'] as const;

/** Keeps the badge equal to badgeCount(replica.sessions); returns the stop function. */
export function watchBadge({ replica, client, nav, doc }: BadgeOptions): () => void {
  let applied: number | undefined;
  const update = (force = false) => {
    const count = badgeCount(replica.sessions);
    if (!force && count === applied) return;
    applied = count;
    applyBadge(nav, count);
  };
  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') update(true);
  };
  const stops = [replica.subscribe(() => update())];
  for (const method of BADGE_EVENTS) if (client !== undefined) stops.push(client.onNotification(method, () => update()));
  doc?.addEventListener('visibilitychange', onVisibility);
  update(true);
  return () => {
    for (const stop of stops.splice(0)) stop();
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}
