// No pinch zoom on iOS (operator decision 2026-10-24: zoom makes no sense anywhere in this app).
//
// iOS Safari ignores user-scalable=no and does not stop a pinch for touch-action: pan-x pan-y alone
// (styles/base.css). It fires its own gesturestart / gesturechange / gestureend events around a pinch;
// cancelling them stops the zoom. The listeners must be non-passive to be allowed to cancel.
//
// Only gesture events are touched: no touchstart or touchmove listener is added, so one-finger scrolling,
// the sheet drag, pull-to-refresh, the chats row swipe and the lab's edge swipe never wait on this code.
// Other browsers never fire gesture events, so there this does nothing.

export const ZOOM_GESTURES = ['gesturestart', 'gesturechange', 'gestureend'] as const;

const cancel = (event: Event): void => event.preventDefault();

/** Cancels Safari's pinch gesture events on `target` (the document). */
export function blockPinchZoom(target: Pick<EventTarget, 'addEventListener'>): void {
  for (const type of ZOOM_GESTURES) target.addEventListener(type, cancel, { passive: false });
}
