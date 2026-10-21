import { render } from 'preact';

import { App } from './app';
import { listenForNavigate } from './pwa/navigate';
import { browserPushEnvironment, type PushWindow } from './pwa/push';
import { startUpdates, UpdatePrompt, type UpdateSignal } from './pwa/UpdatePrompt';
import { Router } from './routes/router';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('index.html has no #app element');
}
// Only the build ships sw.js (web/build/pwa.ts); the dev server never registers a worker.
const updates: UpdateSignal | null =
  import.meta.env.PROD && 'serviceWorker' in navigator ? startUpdates(navigator.serviceWorker, document, () => window.location.reload()) : null;
const router = new Router(window);
// A tapped notification while the app is open: the worker posts the session's path (web/src/pwa/navigate.ts).
if (updates !== null) listenForNavigate(navigator.serviceWorker, window.location.origin, (path) => router.navigate(path));
render(
  <>
    <App router={router} push={updates === null ? null : browserPushEnvironment(window as unknown as PushWindow)} />
    {updates && <UpdatePrompt updates={updates} />}
  </>,
  root,
);
