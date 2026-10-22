// Hooks for the chat screens. useLiveModel subscribes to a view model before the browser paints, so input
// that arrives right after the page appears re-renders it. usePress: a long-press (hold still for
// LONG_PRESS_MS) and a swipe to the left; pointer events cover touch, pen and mouse, and the right-click /
// context menu also counts as a long-press so a desktop browser and assistive tech reach the same action.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * Re-renders on every change of the model, like useModel, but subscribes in a layout effect and catches
 * up on a change made between render and subscription (useModel's passive effect runs after paint, so a
 * fast first keystroke could change the model with nobody listening).
 */
export function useLiveModel<T extends { version: number; subscribe(listener: () => void): () => void }>(model: T): T {
  const [, setTick] = useState(0);
  const rendered = model.version;
  useLayoutEffect(() => {
    const off = model.subscribe(() => setTick((n) => n + 1));
    if (model.version !== rendered) setTick((n) => n + 1);
    return off;
    // `rendered` is read once per subscription on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  return model;
}

export const LONG_PRESS_MS = 500;
/** Further than this (px) is a move, not a press. */
const SLOP = 10;
/** A swipe left of at least this many px. */
const SWIPE = 48;

export interface PressHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: MouseEvent) => void;
  /** True right after a long-press or swipe: the click that follows should not open anything. */
  consumed: () => boolean;
}

export function usePress(actions: { onLongPress: () => void; onSwipeLeft?: () => void }): PressHandlers {
  const latest = useRef(actions);
  latest.current = actions;
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fired = useRef(false);
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
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = undefined;
        start.current = undefined;
        fired.current = true;
        latest.current.onLongPress();
      }, LONG_PRESS_MS);
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
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event) => {
      event.preventDefault();
      cancel();
      fired.current = true;
      latest.current.onLongPress();
    },
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
