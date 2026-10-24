// The touch listener behind a drag that follows the finger (a sheet pulled down, the lab's back swipe). Touch
// events, not pointer events: touchmove is non-passive, so a drag that owns the move can stop the page from
// scrolling. The rules of the drag (speed, release decision) are in gesture.ts.
import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface DragHandlers {
  /** A finger went down at (x, y) on `target`; return false to ignore this touch. */
  start(x: number, y: number, target: EventTarget | null, time: number): boolean;
  /** The finger moved; return true when the drag owns the move (the page must not scroll). */
  move(x: number, y: number, time: number): boolean;
  /** The finger lifted or the touch was cancelled. */
  end(cancelled: boolean): void;
}

/** Touch listeners on `element` while `enabled`; touchmove is non-passive so a drag can call preventDefault. */
export function useDrag(element: RefObject<EventTarget>, enabled: boolean, handlers: DragHandlers): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const el = element.current;
    if (!enabled || el === null) return;
    let active = false;
    const onStart = (event: Event) => {
      const touches = (event as TouchEvent).touches;
      const touch = touches[0];
      active = touches.length === 1 && touch !== undefined && current.current.start(touch.clientX, touch.clientY, event.target, event.timeStamp);
    };
    const onMove = (event: Event) => {
      const touch = (event as TouchEvent).touches[0];
      if (!active || touch === undefined) return;
      if (current.current.move(touch.clientX, touch.clientY, event.timeStamp) && event.cancelable) event.preventDefault();
    };
    const onEnd = (event: Event) => {
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
