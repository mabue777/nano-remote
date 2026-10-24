// Hooks for the chat screens. usePress: a long-press (hold still for
// LONG_PRESS_MS) and a swipe to the left; pointer events cover touch, pen and mouse, and the right-click /
// context menu also counts as a long-press so a desktop browser and assistive tech reach the same action.
// The hold timer can run late on a busy main thread (its task may be queued behind the pointerup), so a
// pointerup that comes LONG_PRESS_MS or more after its pointerdown, by the events' own timestamps, counts
// as the long-press when the timer has not fired yet.
import { useEffect, useRef } from 'preact/hooks';

export const LONG_PRESS_MS = 500;
/** Further than this (px) is a move, not a press. */
const SLOP = 10;
/** A swipe left of at least this many px. */
const SWIPE = 48;

export interface PressHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: () => void;
  onContextMenu: (event: MouseEvent) => void;
  /** True right after a long-press or swipe: the click that follows should not open anything. */
  consumed: () => boolean;
}

export function usePress(actions: { onLongPress: () => void; onSwipeLeft?: () => void }): PressHandlers {
  const latest = useRef(actions);
  latest.current = actions;
  const start = useRef<{ x: number; y: number; at: number } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fired = useRef(false);
  const longPress = () => {
    cancel();
    fired.current = true;
    latest.current.onLongPress();
  };
  const cancel = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    start.current = undefined;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      cancel();
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      timer.current = setTimeout(longPress, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const from = start.current;
      if (from === undefined) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (latest.current.onSwipeLeft !== undefined && dx <= -SWIPE && Math.abs(dy) < SWIPE) {
        cancel();
        fired.current = true;
        latest.current.onSwipeLeft();
      } else if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) {
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = undefined;
      }
    },
    onPointerUp: (event) => {
      // Still armed (held still, timer not yet run) and held long enough: the timer is only late.
      if (timer.current !== undefined && start.current !== undefined && event.timeStamp - start.current.at >= LONG_PRESS_MS) longPress();
      else cancel();
    },
    onPointerCancel: cancel,
    onContextMenu: (event) => {
      event.preventDefault();
      longPress();
    },
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
