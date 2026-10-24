// DOM glue shared by the lab's screens: the FLIP hook, a cross-fading label, and the shell that animates a
// box's height with transform only. The motion tokens (motionOf), the drag listener (useDrag) and
// scrolledAbove moved to src/ui/motion and are re-exported here. Covered by the Playwright lab smoke; the rules
// they apply live in the tested .ts modules next to this file.
import type { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { motionOf, prefersReducedMotion } from '../ui/motion/motion';
import { measure, play, type Box } from './flip';

export { motionOf, type Motion } from '../ui/motion/motion';
export { scrolledAbove } from '../ui/motion/motion';
export { useDrag, type DragHandlers } from '../ui/motion/drag';

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
