// The lab's bottom sheet, with the real sheet's look (.sheet-backdrop, .sheet). Now: it appears and goes
// at once, like ui/Sheet.tsx did before it adopted Smooth (ui/motion/sheet-motion.ts). Smooth: the panel slides up on a spring while the dim layer fades in; a drag
// down follows the finger (from anywhere while the content is scrolled to its top) and on release the
// finger's speed decides between dismissing and springing back.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import { lockAxis, rubberBand, settleDuration, shouldComplete, VelocityTracker } from '../ui/motion/gesture';
import { SHEET_SPRING, springEasing } from '../ui/motion/spring';
import { motionOf, scrolledAbove, useDrag } from './dom';

export interface LabSheetProps {
  /** Smooth sheet (slide, fade, drag to dismiss). */
  smooth: boolean;
  /** Reduced motion: the drag still follows the finger, but nothing animates by itself. */
  reduced: boolean;
  labelledBy: string;
  class?: string;
  /** The sheet is gone (after its exit animation). */
  onClosed: () => void;
  /** The content; `close` runs the exit and then onClosed. */
  children: (close: () => void) => ComponentChildren;
}

const LINEAR_EASING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)');

export function LabSheet({ smooth, reduced, labelledBy, class: extra, onClosed, children }: LabSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const offset = useRef(0);
  const spring = useMemo(() => springEasing(SHEET_SPRING), []);
  const animate = smooth && !reduced;

  const springTiming = (): KeyframeAnimationOptions =>
    LINEAR_EASING ? { duration: spring.durationMs, easing: spring.easing } : { duration: motionOf(panel.current).relaxed, easing: motionOf(panel.current).enter };

  useLayoutEffect(() => {
    if (!animate) return;
    panel.current!.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], springTiming());
    const m = motionOf(panel.current);
    scrim.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.moderate, easing: m.standard });
    // runs once, on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (velocity = 0) => {
    if (closing.current) return;
    closing.current = true;
    const el = panel.current;
    if (!animate || el === null) {
      onClosed();
      return;
    }
    const height = el.offsetHeight || 1;
    const from = offset.current;
    const m = motionOf(el);
    const duration = settleDuration(height - from, velocity, 140, 260);
    const fromOpacity = 1 - Math.min(1, from / height);
    el.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(100%)' }], { duration, easing: velocity > 0.3 ? 'linear' : m.exit, fill: 'forwards' });
    const fade = scrim.current?.animate([{ opacity: fromOpacity }, { opacity: 0 }], { duration, easing: m.standard, fill: 'forwards' });
    window.setTimeout(onClosed, duration);
    void fade;
  };

  // Drag to dismiss.
  const tracker = useRef(new VelocityTracker());
  const drag = useRef<{ x: number; y: number; phase: 'pending' | 'drag' | 'ignore' }>({ x: 0, y: 0, phase: 'ignore' });
  useDrag(panel, smooth, {
    start(x, y, target, time) {
      if (closing.current || panel.current === null || scrolledAbove(target, panel.current)) return false;
      drag.current = { x, y, phase: 'pending' };
      tracker.current.reset();
      tracker.current.add(time, y);
      return true;
    },
    move(x, y, time) {
      const el = panel.current!;
      const state = drag.current;
      if (state.phase === 'ignore') return false;
      if (state.phase === 'pending') {
        const axis = lockAxis(x - state.x, y - state.y);
        if (axis === undefined) return false;
        if (axis === 'x' || y < state.y) {
          state.phase = 'ignore'; // sideways or upwards: not a dismiss; the content scrolls
          return false;
        }
        state.phase = 'drag';
        state.y = y;
        for (const a of el.getAnimations()) a.cancel();
      }
      const dy = y - state.y;
      const at = dy >= 0 ? dy : -rubberBand(-dy, 40);
      offset.current = at;
      el.style.transform = `translateY(${at}px)`;
      if (scrim.current !== null) scrim.current.style.opacity = String(1 - Math.min(1, Math.max(0, at) / (el.offsetHeight || 1)));
      tracker.current.add(time, y);
      return true;
    },
    end() {
      const el = panel.current;
      const state = drag.current;
      const dragged = state.phase === 'drag';
      state.phase = 'ignore';
      if (!dragged || el === null) return;
      const velocity = tracker.current.velocity();
      const height = el.offsetHeight || 1;
      if (shouldComplete(offset.current, velocity, height, { distanceRatio: 0.3 })) {
        el.style.transform = '';
        if (scrim.current !== null) scrim.current.style.opacity = '';
        close(velocity);
        return;
      }
      const from = offset.current;
      offset.current = 0;
      el.style.transform = '';
      if (scrim.current !== null) scrim.current.style.opacity = '';
      if (reduced) return;
      el.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], springTiming());
      const m = motionOf(el);
      scrim.current?.animate([{ opacity: 1 - Math.min(1, Math.max(0, from) / height) }, { opacity: 1 }], { duration: m.moderate, easing: m.standard });
    },
  });

  return (
    <div class={`sheet-backdrop${smooth ? ' lab-sheet-smooth' : ''}`} onClick={(event) => !smooth && event.target === event.currentTarget && close()}>
      {smooth && <div class="lab-scrim" ref={scrim} onClick={() => close()} />}
      <section ref={panel} class={extra === undefined ? 'sheet' : `sheet ${extra}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {smooth && <div class="lab-grabber" aria-hidden="true" />}
        {children(() => close())}
      </section>
    </div>
  );
}
