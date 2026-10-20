import { render } from 'preact';

import { App } from './app';
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
render(
  <>
    <App router={new Router(window)} />
    {updates && <UpdatePrompt updates={updates} />}
  </>,
  root,
);
