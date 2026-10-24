// The motion tokens (--duration-*, --ease-* in styles/tokens.css) as numbers and strings for the Web
// Animations API, the reduced-motion setting, and whether a touch sits in content scrolled away from its top.
// Small browser facts behind interfaces so they can be tested in Node.

export interface MediaWindow {
  matchMedia?: (query: string) => { matches: boolean };
}

export function prefersReducedMotion(win: MediaWindow | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** "150ms" or "0.3s" as milliseconds; `fallback` for anything else. */
export function parseMs(value: string, fallback: number): number {
  const text = value.trim();
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text);
  if (match === null) return fallback;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return fallback;
  return match[2] === 's' ? n * 1000 : n;
}

export interface Motion {
  fast: number;
  moderate: number;
  relaxed: number;
  standard: string;
  enter: string;
  exit: string;
}

type StyleReader = (element: Element) => { getPropertyValue(name: string): string };

/** The motion tokens as tokens.css defines them for `element`; the same defaults if a value is missing. */
export function motionOf(element: Element | null, styleOf: StyleReader = (el) => getComputedStyle(el)): Motion {
  const style = element === null ? null : styleOf(element);
  const read = (name: string) => style?.getPropertyValue(name).trim() ?? '';
  return {
    fast: parseMs(read('--duration-fast'), 150),
    moderate: parseMs(read('--duration-moderate'), 200),
    relaxed: parseMs(read('--duration-relaxed'), 300),
    standard: read('--ease-standard') || 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: read('--ease-enter') || 'cubic-bezier(0.23, 1, 0.32, 1)',
    exit: read('--ease-exit') || 'cubic-bezier(0.4, 0, 1, 1)',
  };
}

interface ScrollNode {
  scrollTop: number;
  parentElement: ScrollNode | null;
}

/** Whether `target` sits in something scrolled away from its top, between it and `stop` (both included). */
export function scrolledAbove(target: unknown, stop: unknown): boolean {
  let node = isScrollNode(target) ? target : null;
  while (node !== null) {
    if (node.scrollTop > 0) return true;
    if (node === stop) return false;
    node = node.parentElement;
  }
  return false;
}

function isScrollNode(value: unknown): value is ScrollNode {
  return typeof value === 'object' && value !== null && 'scrollTop' in value && 'parentElement' in value;
}
