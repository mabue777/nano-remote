// The DOM side of the transcript's motion (docs/research/interaction-feel-prototype.md, techniques 4, 5 and 9),
// built in the lab (/lab) and shared by the session view, local chat and the lab: FLIP for expand and collapse,
// paced streaming text, and the auto-scroll follower. The rules live in tested modules (ui/motion/flip.ts,
// pacer.ts, autoscroll.ts); these hooks only wire them to elements and frames. Covered by the Playwright smoke.
// Only transform and opacity animate; with Reduce Motion nothing is paced or eased.
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { BOTTOM_SLACK, distanceFromBottom, Follower } from '../../ui/motion/autoscroll';
import { measure, play, type Box } from '../../ui/motion/flip';
import { motionOf, prefersReducedMotion } from '../../ui/motion/motion';
import { FrameLoop, TextReveal, type RevealView } from '../../ui/motion/pacer';
import { riseEntered } from '../../ui/motion/sending';

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && prefersReducedMotion(window);
}

const raf = (cb: (time: number) => void) => window.requestAnimationFrame(cb);
const caf = (handle: number) => window.cancelAnimationFrame(handle);

// ---- FLIP ------------------------------------------------------------------------------------------

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

/**
 * FLIP for one container: measures the rows (`[data-flip-key]`) and the shelled boxes (`[data-shell-key]`),
 * lets the change render, then animates rows from their old places and shells from their old heights. With
 * `enabled` false (Reduce Motion) it only runs the update.
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
function growShells(container: HTMLElement, before: Map<string, number>, timing: { duration: number; easing: string }): void {
  container.querySelectorAll<HTMLElement>('[data-shell-key]').forEach((el) => {
    const from = before.get(el.dataset.shellKey!);
    const to = el.offsetHeight;
    const shell = el.querySelector<HTMLElement>(':scope > .lab-shell, :scope > .shell');
    if (from === undefined || to === 0 || from === to || shell === null) return;
    shell.animate([{ transform: `scaleY(${from / to})` }, { transform: 'scaleY(1)' }], timing);
  });
}

/**
 * Collapses an open part (`[data-body="key"]`): its content fades out, then `remove` runs inside a FLIP so
 * what follows slides up. Without motion, or when the part is not on screen, `remove` runs at once.
 */
export function collapse(container: HTMLElement | null, key: string, flip: Flip, remove: () => void, enabled: boolean): void {
  const body = enabled ? container?.querySelector<HTMLElement>(`[data-body="${CSS.escape(key)}"]`) : null;
  if (body === null || body === undefined || typeof body.animate !== 'function') {
    flip(remove);
    return;
  }
  const m = motionOf(body);
  const fade = body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: m.fast, easing: m.standard, fill: 'forwards' });
  fade.onfinish = () => flip(remove);
}

// ---- Streaming text ----------------------------------------------------------------------------------

/**
 * A message's text as it streams: what the Replica appended is revealed a few characters per frame and the
 * newest pieces fade in. Text that was complete when the view appeared shows at once; a rewritten text (a
 * snapshot after a reconnect) shows at once too, so no delta is lost or shown twice.
 */
export function usePacedText(text: string, streaming: boolean): RevealView {
  const [, setFrame] = useState(0);
  const reveal = useMemo(() => new TextReveal(streaming ? '' : text, reducedMotion()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const loop = useMemo(
    () =>
      new FrameLoop(
        (dt) => {
          reveal.frame(dt, performance.now());
          setFrame((n) => n + 1);
        },
        () => reveal.active,
        raf,
        caf,
      ),
    [reveal],
  );
  reveal.set(text, typeof performance === 'undefined' ? 0 : performance.now());
  useEffect(() => {
    if (reveal.active) loop.start();
  }, [text, reveal, loop]);
  useEffect(() => () => loop.stop(), [loop]);
  return reveal.view;
}

// ---- Auto-scroll -----------------------------------------------------------------------------------

export interface AutoScroll {
  /** "Jump to latest" shows: the reader left the bottom. */
  pill: boolean;
  /** Follow the bottom again and glide there (the pill, a send). */
  jump(): void;
  /** Go to the bottom at once and follow it: the page has landed (until then new content snaps, after it glides). */
  snap(): void;
  /** Go to the bottom at once and keep following (a send, before its rows glide): its scroll is ours, not the reader's. */
  pin(): void;
  /** Whether it follows the bottom now. */
  following(): boolean;
  /** For the scroller element. */
  handlers: {
    onScroll: () => void;
    onTouchStart: () => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
}

/**
 * Follows a growing transcript: while the reader is at the bottom each frame eases toward the new bottom;
 * the first touch, or a scroll up, stops it until they come back to the bottom or tap the pill. `content` is
 * the element holding everything that scrolls (turns, cards), so the view reaches the end of whatever grew.
 * `onFollow` hears every change of following.
 */
export function useAutoScroll(scroller: RefObject<HTMLElement>, content: RefObject<HTMLElement>, onFollow?: (following: boolean) => void): AutoScroll {
  const [pill, setPill] = useState(false);
  const follow = useRef(onFollow);
  follow.current = onFollow;
  const follower = useMemo(() => new Follower(reducedMotion() ? 1 : 0.35), []);
  const landed = useRef(false);
  const loop = useMemo(
    () =>
      new FrameLoop(
        (dtMs) => {
          const el = scroller.current;
          if (el === null) return;
          const next = follower.step(el, dtMs);
          if (next !== undefined) el.scrollTop = next;
        },
        () => scroller.current !== null && follower.following && distanceFromBottom(scroller.current) > 0.5,
        raf,
        caf,
      ),
    [follower, scroller],
  );
  const update = () => {
    const el = scroller.current;
    if (el === null) return;
    setPill(!follower.following && distanceFromBottom(el) > BOTTOM_SLACK);
    follow.current?.(follower.following);
  };
  const snap = () => {
    const el = scroller.current;
    if (el === null) return;
    landed.current = true;
    follower.jump();
    el.scrollTop = el.scrollHeight;
    follower.onScroll(el); // our own scroll: it counts as being at the bottom
    update();
  };

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (el === null || inner === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      // Until the page has landed (snap), the content is still arriving: stay at the bottom without gliding.
      if (!landed.current) {
        if (follower.following) el.scrollTop = el.scrollHeight;
        return;
      }
      loop.start();
      update();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
    // update reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, content, follower, loop]);
  useEffect(() => () => loop.stop(), [loop]);

  return {
    pill,
    jump: () => {
      follower.jump();
      setPill(false);
      follow.current?.(true);
      loop.start();
    },
    snap,
    pin: () => {
      const el = scroller.current;
      if (el === null) return;
      follower.jump();
      el.scrollTop = el.scrollHeight - el.clientHeight;
      follower.scrolledTo(el.scrollTop);
      setPill(false);
      follow.current?.(true);
    },
    following: () => follower.following,
    handlers: {
      onScroll: () => {
        const el = scroller.current;
        if (el === null) return;
        follower.onScroll(el);
        update();
      },
      onTouchStart: () => follower.hold(),
      onTouchEnd: () => {
        const el = scroller.current;
        if (el === null) return;
        follower.release(el);
        update();
        loop.start();
      },
      onTouchCancel: () => {
        const el = scroller.current;
        if (el === null) return;
        follower.release(el);
        update();
      },
    },
  };
}
