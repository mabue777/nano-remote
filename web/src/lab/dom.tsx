// DOM glue shared by the lab's screens: motion values read from lab.css, the FLIP hook, a cross-fading
// label, the drag listener (touch events, non-passive so a drag can stop the page from scrolling), and the
// shell that animates a box's height with transform only. Covered by the Playwright lab smoke; the rules
// they apply live in the tested .ts modules next to this file.
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { measure, play, type Box } from './flip';
import { parseMs, prefersReducedMotion } from './viewport';

export interface Motion {
  fast: number;
  moderate: number;
  relaxed: number;
  standard: string;
  enter: string;
  exit: string;
}

/** The motion values as lab.css defines them (`--duration-*`, `--ease-*`); defaults if the sheet is missing. */
export function motionOf(element: Element | null): Motion {
  const style = element === null ? null : getComputedStyle(element);
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

export function reducedMotion(): boolean {
  return prefersReducedMotion(window);
}

export interface FlipRequest {
  /** Whether new rows get FLIP's own fade and scale (false: they have a CSS entrance). */
  enter?: boolean;
  /** Runs after the change rendered and before the rows animate (e.g. pin the transcript to the bottom). */
  beforePlay?: () => void;
}

/**
 * FLIP for one container: `flip(update)` measures the rows (`[data-flip-key]`) and the shelled boxes
 * (`[data-shell-key]`), runs the update, and after the render animates rows from their old places and shells
 * from their old heights. With `enabled` false it only runs the update.
 */
export function useFlip(container: RefObject<HTMLElement>, enabled: boolean): (update: () => void, request?: FlipRequest) => void {
  const pending = useRef<{ before: Map<string, Box>; heights: Map<string, number>; request: FlipRequest } | null>(null);
  useLayoutEffect(() => {
    const job = pending.current;
    const element = container.current;
    if (job === null || element === null) return;
    pending.current = null;
    job.request.beforePlay?.();
    const m = motionOf(element);
    play(element, job.before, { duration: m.relaxed, easing: m.standard }, job.request.enter ?? true);
    growShells(element, job.heights, { duration: m.relaxed, easing: m.standard });
  });
  return (update, request = {}) => {
    const element = container.current;
    if (enabled && element !== null) pending.current = { before: measure(element), heights: shellHeights(element), request };
    update();
  };
}

function shellHeights(container: HTMLElement): Map<string, number> {
  const heights = new Map<string, number>();
  container.querySelectorAll<HTMLElement>('[data-shell-key]').forEach((el) => heights.set(el.dataset.shellKey!, el.offsetHeight));
  return heights;
}

/** A shelled box changed height: its background (`.lab-shell`) scales from the old height to the new one. */
function growShells(container: HTMLElement, before: Map<string, number>, timing: { duration: number; easing: string }): void {
  container.querySelectorAll<HTMLElement>('[data-shell-key]').forEach((el) => {
    const from = before.get(el.dataset.shellKey!);
    const to = el.offsetHeight;
    const shell = el.querySelector<HTMLElement>(':scope > .lab-shell');
    if (from === undefined || to === 0 || from === to || shell === null) return;
    shell.animate([{ transform: `scaleY(${from / to})` }, { transform: 'scaleY(1)' }], timing);
  });
}

/** The background layer of a shelled box (see `.lab-shelled` in lab.css). */
export function Shell() {
  return <span class="lab-shell" aria-hidden="true" />;
}

/** A label that cross-fades when `value` changes (smooth), or simply changes (now). */
export function CrossFade({ value, smooth, render }: { value: string; smooth: boolean; render: (value: string) => ComponentChildren }) {
  const [leaving, setLeaving] = useState<string[]>([]);
  const last = useRef(value);
  useLayoutEffect(() => {
    if (last.current === value) return;
    const old = last.current;
    last.current = value;
    if (smooth) setLeaving((list) => [...list.filter((v) => v !== value), old]);
  }, [value, smooth]);
  if (!smooth) return <>{render(value)}</>;
  return (
    <span class="lab-xfade">
      {leaving.map((v) => (
        <span key={`out-${v}`} class="lab-xfade-out" aria-hidden="true" onAnimationEnd={() => setLeaving((list) => list.filter((x) => x !== v))}>
          {render(v)}
        </span>
      ))}
      <span key={`in-${value}`} class={leaving.length > 0 ? 'lab-xfade-in' : undefined}>
        {render(value)}
      </span>
    </span>
  );
}

export interface DragHandlers {
  /** A finger went down at (x, y) on `target`; return false to ignore this touch. */
  start(x: number, y: number, target: EventTarget | null, time: number): boolean;
  /** The finger moved; return true when the drag owns the move (the page must not scroll). */
  move(x: number, y: number, time: number): boolean;
  /** The finger lifted or the touch was cancelled. */
  end(cancelled: boolean): void;
}

/** Touch listeners on `element` while `enabled`; touchmove is non-passive so a drag can call preventDefault. */
export function useDrag(element: RefObject<HTMLElement>, enabled: boolean, handlers: DragHandlers): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const el = element.current;
    if (!enabled || el === null) return;
    let active = false;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      active = event.touches.length === 1 && touch !== undefined && current.current.start(touch.clientX, touch.clientY, event.target, event.timeStamp);
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!active || touch === undefined) return;
      if (current.current.move(touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
    };
    const onEnd = (event: TouchEvent) => {
      if (!active) return;
      active = false;
      current.current.end(event.type === 'touchcancel');
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [element, enabled]);
}

/** Whether `target` sits in something scrolled away from its top, between it and `stop`. */
export function scrolledAbove(target: EventTarget | null, stop: Element): boolean {
  let node = target instanceof Element ? target : null;
  while (node !== null) {
    if (node.scrollTop > 0) return true;
    if (node === stop) return false;
    node = node.parentElement;
  }
  return false;
}
