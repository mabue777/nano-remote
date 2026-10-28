import { render } from 'preact';

import { App } from './app';
import { listenForNavigate } from './pwa/navigate';
import { browserPushEnvironment, type PushWindow } from './pwa/push';
import { startUpdates, UpdatePrompt, type UpdateSignal } from './pwa/UpdatePrompt';
import { browserOwnsEdge } from './routes/PageStack';
import { Router } from './routes/router';
import { guessBrowserSwipe } from './ui/motion/page-motion';
import { blockPinchZoom } from './ui/no-zoom';
import './styles/index.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('index.html has no #app element');
}
// Only the build ships sw.js (web/build/pwa.ts); the dev server never registers a worker.
const updates: UpdateSignal | null =
  import.meta.env.PROD && 'serviceWorker' in navigator ? startUpdates(navigator.serviceWorker, document, () => window.location.reload()) : null;
// Press feedback: iOS Safari applies :active (styles/base.css) only while the page has a touchstart listener.
// Passive, so it never delays a scroll. It also notes whether a finger is down, for the guess below.
const touch = { down: false, lastEnd: -Infinity };
document.addEventListener('touchstart', () => void (touch.down = true), { passive: true });
for (const type of ['touchend', 'touchcancel'] as const) {
  document.addEventListener(
    type,
    (event) => {
      touch.down = event.touches.length > 0;
      touch.lastEnd = performance.now();
    },
    { passive: true },
  );
}
// No pinch zoom on iOS: Safari's gesture events are cancelled (src/ui/no-zoom.ts; touch-action in styles/base.css).
blockPinchZoom(document);
// A back step that Safari already animated (its own swipe in a tab) does not slide again (ui/motion/page-motion.ts).
const ownsEdge = browserOwnsEdge();
const router = new Router(window, {
  browserAnimated: (event) => guessBrowserSwipe(event, { ownsEdge, down: touch.down, lastEnd: touch.lastEnd, now: performance.now() }),
});
// A tapped notification while the app is open: the worker posts the session's path (web/src/pwa/navigate.ts).
if (updates !== null) listenForNavigate(navigator.serviceWorker, window.location.origin, (path) => router.navigate(path));
render(
  <>
    <App router={router} push={updates === null ? null : browserPushEnvironment(window as unknown as PushWindow)} />
    {updates && <UpdatePrompt updates={updates} />}
  </>,
  root,
);
