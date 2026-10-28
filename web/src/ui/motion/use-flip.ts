// FLIP as hooks (docs/research/interaction-feel-prototype.md, techniques 8 and 9), built in the lab and
// shared by the session view, local chat, Home's session list, the chat list and the lab. The rules live in
// flip.ts and list-motion.ts; these hooks only wire them to elements and renders. Only transform and opacity
// animate; with `enabled` false (Reduce Motion) nothing is measured or eased.
import type { RefObject } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { markPlayed, measure, play, type Box, type Shown } from './flip';
import { ListMotion } from './list-motion';
import { motionOf } from './motion';
import { riseEntered } from './sending';

export interface FlipRequest {
  /** Whether new rows get FLIP's own fade and scale (false: they have a CSS entrance). */
  enter?: boolean;
  /** Runs after the change rendered and before the rows animate (e.g. pin the transcript to the bottom). */
  beforePlay?: () => void;
  /** New rows matching this selector rise out of the composer (Sending, ui/motion/sending.ts). */
  rise?: string;
}

export interface Flip {
  /** Measures the rows, runs `update`, and animates the rows from their old places after the render. */
  (update: () => void, request?: FlipRequest): void;
  /** Measures now; the next render of the owner animates from here (for changes that arrive from a model). */
  prepare(request?: FlipRequest): void;
}

interface Timing {
  duration: number;
  easing: string;
}

/**
 * FLIP for one container: measures the rows (`[data-flip-key]`) and the shelled boxes (`[data-shell-key]`),
 * lets the change render, then animates rows from their old places and shells from their old heights, and
 * marks what it played (`data-flip-anim`, flip.ts markPlayed). With `enabled` false it only runs the update.
 */
export function useFlip(container: RefObject<HTMLElement>, enabled: boolean): Flip {
  const pending = useRef<{ before: Map<string, Box>; heights: Map<string, number>; request: FlipRequest } | null>(null);
  useLayoutEffect(() => {
    const job = pending.current;
    const element = container.current;
    if (job === null || element === null) return;
    pending.current = null;
    job.request.beforePlay?.();
    const m = motionOf(element);
    const plan = play(element, job.before, { duration: m.relaxed, easing: m.standard }, job.request.enter ?? true);
    markPlayed(element, plan);
    if (job.request.rise !== undefined) riseEntered(element, plan.entered, job.request.rise, { duration: m.moderate, easing: m.enter });
    growShells(element, job.heights, { duration: m.relaxed, easing: m.standard });
  });
  return useMemo(() => {
    const prepare = (request: FlipRequest = {}) => {
      const element = container.current;
      if (enabled && element !== null && pending.current === null) pending.current = { before: measure(element), heights: shellHeights(element), request };
    };
    const flip = ((update: () => void, request: FlipRequest = {}) => {
      prepare(request);
      update();
    }) as Flip;
    flip.prepare = prepare;
    return flip;
  }, [container, enabled]);
}

function shellHeights(container: HTMLElement): Map<string, number> {
  const heights = new Map<string, number>();
  container.querySelectorAll<HTMLElement>('[data-shell-key]').forEach((el) => heights.set(el.dataset.shellKey!, el.offsetHeight));
  return heights;
}

/** A shelled box changed height: its background (`.shell`) scales from the old height to the new one. */
function growShells(container: HTMLElement, before: Map<string, number>, timing: Timing): void {
  container.querySelectorAll<HTMLElement>('[data-shell-key]').forEach((el) => {
    const from = before.get(el.dataset.shellKey!);
    const to = el.offsetHeight;
    const shell = el.querySelector<HTMLElement>(':scope > .lab-shell, :scope > .shell');
    if (from === undefined || to === 0 || from === to || shell === null) return;
    shell.animate([{ transform: `scaleY(${from / to})` }, { transform: 'scaleY(1)' }], timing);
  });
}

export interface ListMotionView<T> {
  /** The rows to render: `leaving` ones fade out at their old place (class `leaving`, no data-flip-key). */
  shown: Shown<T>[];
  /** A leaving row's fade ended (its animationend): it goes and the rows under it close the gap. */
  dropped(key: string): void;
}

/**
 * List changes for a list a model renders: when the rows change (added, removed, reordered, filtered) it
 * measures them during the render, before the page changes, and the container's FLIP slides the rows that
 * moved, fades and grows the new ones, and keeps the removed ones until their fade-out ends.
 */
export function useListMotion<T>(items: readonly T[], keyOf: (item: T) => string, container: RefObject<HTMLElement>, enabled: boolean): ListMotionView<T> {
  const flip = useFlip(container, enabled);
  const list = useRef<ListMotion<T> | null>(null);
  list.current ??= new ListMotion(keyOf);
  const [, setDrops] = useState(0);
  const step = list.current.next(items, enabled);
  if (step.changed) flip.prepare(); // the page still shows the old rows: this is FLIP's First
  return {
    shown: step.shown,
    dropped: (key) => {
      if (!list.current!.leaving(key)) return;
      flip(() => {
        list.current!.drop(key);
        setDrops((n) => n + 1);
      });
    },
  };
}
