import { describe, expect, it, vi } from 'vitest';

import { applyBadge, badgeCount, BADGE_EVENTS, watchBadge, type BadgeNavigator } from './badge';

const pending = (approvals: number, inputs: number) => ({ pending: { approvals, inputs } });

/** A navigator whose badge calls record 0 for a clear. */
function recorder(): BadgeNavigator & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    setAppBadge: vi.fn(async (n?: number) => void calls.push(n ?? -1)),
    clearAppBadge: vi.fn(async () => void calls.push(0)),
  };
}

describe('badgeCount', () => {
  it('sums pending approvals and questions over the list', () => {
    expect(badgeCount([])).toBe(0);
    expect(badgeCount([pending(1, 0), pending(0, 2), pending(0, 0)])).toBe(3);
  });

  it('ignores missing, negative and non-number counts', () => {
    const odd = [{ pending: { approvals: -2, inputs: Number.NaN } }, {} as never, { pending: { approvals: 1, inputs: 1 } }];
    expect(badgeCount(odd)).toBe(2);
  });
});

describe('applyBadge', () => {
  it('sets a positive count and clears at 0', () => {
    const nav = recorder();
    expect(applyBadge(nav, 4)).toBe(true);
    expect(applyBadge(nav, 0)).toBe(true);
    expect(nav.calls).toEqual([4, 0]);
  });

  it('is a no-op without the Badging API, and never throws', async () => {
    expect(applyBadge(undefined, 3)).toBe(false);
    expect(applyBadge({}, 3)).toBe(false);
    expect(applyBadge({ setAppBadge: async () => undefined }, 0)).toBe(false); // no clear: nothing to do
    const throwing: BadgeNavigator = {
      setAppBadge: () => {
        throw new Error('SecurityError');
      },
    };
    expect(applyBadge(throwing, 1)).toBe(false);
    const rejecting: BadgeNavigator = { clearAppBadge: () => Promise.reject(new Error('NotAllowedError')) };
    expect(applyBadge(rejecting, 0)).toBe(true);
    await Promise.resolve(); // the rejection is caught, not unhandled
    const sync = { setAppBadge: (() => undefined) as unknown as BadgeNavigator['setAppBadge'] };
    expect(applyBadge(sync, 2)).toBe(true);
  });
});

describe('watchBadge', () => {
  function setup(withDoc = true) {
    let sessions = [pending(0, 0)];
    const replicaListeners = new Set<() => void>();
    const handlers = new Map<string, (params: Record<string, unknown>, method: string) => void>();
    const docListeners = new Set<() => void>();
    const replica = {
      get sessions() {
        return sessions;
      },
      subscribe: (fn: () => void) => (replicaListeners.add(fn), () => replicaListeners.delete(fn)),
    };
    const client = {
      onNotification: (method: string, fn: (params: Record<string, unknown>, method: string) => void) => (handlers.set(method, fn), () => void handlers.delete(method)),
    };
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_: 'visibilitychange', fn: () => void) => docListeners.add(fn),
      removeEventListener: (_: 'visibilitychange', fn: () => void) => docListeners.delete(fn),
    };
    const nav = recorder();
    const stop = watchBadge({ replica, client, nav, ...(withDoc ? { doc } : {}) });
    const set = (next: typeof sessions) => {
      sessions = next;
    };
    const changed = () => replicaListeners.forEach((fn) => fn());
    return { nav, set, changed, handlers, doc, docListeners, replicaListeners, stop };
  }

  it('applies at start and after every Replica change, only when the count moves', () => {
    const { nav, set, changed } = setup();
    expect(nav.calls).toEqual([0]);
    set([pending(1, 0)]);
    changed();
    changed(); // same count: no second call
    set([pending(1, 0), pending(0, 1)]);
    changed();
    set([]);
    changed();
    expect(nav.calls).toEqual([0, 1, 2, 0]);
  });

  it('recomputes on request events and re-applies when the page becomes visible', () => {
    const { nav, set, handlers, doc, docListeners } = setup();
    expect([...handlers.keys()]).toEqual([...BADGE_EVENTS]);
    set([pending(1, 0)]);
    handlers.get('approval/request')!({}, 'approval/request');
    set([pending(1, 1)]);
    handlers.get('input/request')!({}, 'input/request');
    set([pending(0, 1)]);
    handlers.get('request/resolved')!({}, 'request/resolved');
    expect(nav.calls).toEqual([0, 1, 2, 1]);
    doc.visibilityState = 'hidden';
    docListeners.forEach((fn) => fn());
    expect(nav.calls).toEqual([0, 1, 2, 1]);
    doc.visibilityState = 'visible';
    docListeners.forEach((fn) => fn());
    expect(nav.calls).toEqual([0, 1, 2, 1, 1]); // same count, applied again
  });

  it('stop removes every listener; works without client or document', () => {
    const { stop, handlers, docListeners, replicaListeners } = setup();
    stop();
    expect(handlers.size + docListeners.size + replicaListeners.size).toBe(0);
    const bare = setup(false);
    bare.stop();
    const nav = recorder();
    const stopMinimal = watchBadge({ replica: { sessions: [pending(2, 0)], subscribe: () => () => undefined }, nav });
    expect(nav.calls).toEqual([2]);
    stopMinimal();
  });
});
