// Runs a Preact hook outside a component, for unit tests in the node environment (no DOM). A test replaces
// preact/hooks with `hooks` from here:
//
//   vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);
//
// then `renderHook(() => useSomething(...))` calls the hook once; a state setter re-renders synchronously, and
// `host.value` is the latest return value. Effects run after each render whose deps changed; a cleanup runs
// before its effect runs again and on `unmount()`. Only useState, useRef and useEffect are provided.

interface Effect {
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | void;
}

export class HookHost<T> {
  value!: T;
  /** One entry per hook call, in call order: a state value, a ref object, or an effect record. */
  readonly slots: unknown[] = [];
  readonly effects = new Set<number>();
  private index = 0;
  private pending: (() => void)[] = [];

  constructor(private readonly hook: () => T) {
    this.render();
  }

  render(): T {
    const previous = current;
    current = this as HookHost<unknown>;
    this.index = 0;
    try {
      this.value = this.hook();
    } finally {
      current = previous;
    }
    const run = this.pending;
    this.pending = [];
    for (const effect of run) effect();
    return this.value;
  }

  unmount(): void {
    for (const index of this.effects) {
      const effect = this.slots[index] as Effect;
      if (typeof effect.cleanup === 'function') effect.cleanup();
    }
  }

  /** The next slot's index; `init` fills it on the first render. */
  next(init: () => unknown): number {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = init();
    return index;
  }

  schedule(effect: () => void): void {
    this.pending.push(effect);
  }
}

let current: HookHost<unknown> | null = null;

function owner(): HookHost<unknown> {
  if (current === null) throw new Error('hook called outside renderHook');
  return current;
}

export const hooks = {
  useState<S>(initial: S): [S, (next: S | ((previous: S) => S)) => void] {
    const host = owner();
    const index = host.next(() => initial);
    const set = (next: S | ((previous: S) => S)) => {
      host.slots[index] = typeof next === 'function' ? (next as (previous: S) => S)(host.slots[index] as S) : next;
      host.render();
    };
    return [host.slots[index] as S, set];
  },
  useRef<R>(initial: R): { current: R } {
    const host = owner();
    return host.slots[host.next(() => ({ current: initial }))] as { current: R };
  },
  useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]): void {
    const host = owner();
    const index = host.next(() => undefined);
    const previous = host.slots[index] as Effect | undefined;
    const same = previous?.deps !== undefined && deps !== undefined && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps![i]));
    if (same) return;
    host.schedule(() => {
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      host.slots[index] = { deps, cleanup: effect() } satisfies Effect;
      host.effects.add(index);
    });
  },
};

export function renderHook<T>(hook: () => T): HookHost<T> {
  return new HookHost(hook);
}
