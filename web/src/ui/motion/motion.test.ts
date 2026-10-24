import { afterEach, describe, expect, it } from 'vitest';

import { motionOf, parseMs, prefersReducedMotion, scrolledAbove } from './motion';

describe('prefersReducedMotion and parseMs', () => {
  const realWindow = globalThis.window;
  afterEach(() => {
    globalThis.window = realWindow;
  });

  it('reads the reduced-motion media query, false without matchMedia or a window', () => {
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion()).toBe(false); // no window in Node
    globalThis.window = { matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) } as unknown as Window & typeof globalThis;
    expect(prefersReducedMotion()).toBe(true);
  });

  it('parses CSS times', () => {
    expect(parseMs('150ms', 1)).toBe(150);
    expect(parseMs(' 0.3s ', 1)).toBe(300);
    expect(parseMs('', 7)).toBe(7);
    expect(parseMs('fast', 7)).toBe(7);
    expect(parseMs('1.2.3ms', 7)).toBe(7);
  });
});

describe('motionOf', () => {
  it('reads the tokens from the element style', () => {
    const values: Record<string, string> = {
      '--duration-fast': ' 120ms',
      '--duration-moderate': '0.25s',
      '--duration-relaxed': '1ms',
      '--ease-standard': 'ease',
      '--ease-enter': 'ease-out',
      '--ease-exit': 'ease-in',
    };
    const m = motionOf({} as Element, () => ({ getPropertyValue: (name) => values[name] ?? '' }));
    expect(m).toEqual({ fast: 120, moderate: 250, relaxed: 1, standard: 'ease', enter: 'ease-out', exit: 'ease-in' });
  });

  it('falls back to the token defaults without an element or a value', () => {
    const defaults = { fast: 150, moderate: 200, relaxed: 300, standard: 'cubic-bezier(0.4, 0, 0.2, 1)', enter: 'cubic-bezier(0.23, 1, 0.32, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' };
    expect(motionOf(null)).toEqual(defaults);
    expect(motionOf({} as Element, () => ({ getPropertyValue: () => '' }))).toEqual(defaults);
  });

  it('uses getComputedStyle by default', () => {
    const real = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (n: string) => (n === '--duration-fast' ? '90ms' : '') })) as unknown as typeof getComputedStyle;
    try {
      expect(motionOf({} as Element).fast).toBe(90);
    } finally {
      globalThis.getComputedStyle = real;
    }
  });
});

describe('scrolledAbove', () => {
  const node = (scrollTop: number, parentElement: unknown = null) => ({ scrollTop, parentElement });

  it('is true when the target or an ancestor up to the stop is scrolled', () => {
    const stop = node(0);
    const list = node(40, stop);
    const row = node(0, list);
    expect(scrolledAbove(row, stop)).toBe(true);
    expect(scrolledAbove(node(0, node(5, stop)), stop)).toBe(true);
    expect(scrolledAbove(node(0, node(0, node(10))), node(0))).toBe(true); // stop never met: walks to the root
  });

  it('is false when nothing is scrolled, and stops at the stop', () => {
    const scrolledPage = node(300);
    const stop = node(0, scrolledPage);
    expect(scrolledAbove(node(0, node(0, stop)), stop)).toBe(false);
    expect(scrolledAbove(node(0), node(0))).toBe(false);
  });

  it('is false for a target that is no element', () => {
    expect(scrolledAbove(null, node(0))).toBe(false);
    expect(scrolledAbove({} as EventTarget, node(0))).toBe(false);
  });
});
