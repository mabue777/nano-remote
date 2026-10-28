// The DOM side of the transcript's motion (docs/research/interaction-feel-prototype.md, techniques 4, 5 and 9),
// built in the lab (/lab) and shared by the session view, local chat and the lab: FLIP for expand and collapse
// (the hook itself is ui/motion/use-flip.ts), paced streaming text, and the auto-scroll follower. The rules live in tested modules (ui/motion/flip.ts,
// pacer.ts, autoscroll.ts); these hooks only wire them to elements and frames. Covered by the Playwright smoke.
// Only transform and opacity animate; with Reduce Motion nothing is paced or eased.
import type { RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { BOTTOM_SLACK, distanceFromBottom, Follower } from '../../ui/motion/autoscroll';
import { motionOf, prefersReducedMotion } from '../../ui/motion/motion';
import { FrameLoop, TextReveal, type RevealView } from '../../ui/motion/pacer';
import type { Flip } from '../../ui/motion/use-flip';

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && prefersReducedMotion(window);
}

const raf = (cb: (time: number) => void) => window.requestAnimationFrame(cb);
const caf = (handle: number) => window.cancelAnimationFrame(handle);

// ---- FLIP ------------------------------------------------------------------------------------------

// The FLIP hook moved to ui/motion/use-flip.ts when Home's list adopted it (look step 6).
export { useFlip, type Flip, type FlipRequest } from '../../ui/motion/use-flip';

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
  /** Notify the follower that the app is changing the layout (FLIP/collapse) so it does not treat the resulting scroll as a reader gesture. */
  layout: {
    start(): void;
    end(): void;
  };
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
      follower.scrolledTo(el);
      setPill(false);
      follow.current?.(true);
    },
    following: () => follower.following,
    layout: {
      start: () => follower.startLayoutChange(),
      end: () => follower.endLayoutChange(),
    },
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
