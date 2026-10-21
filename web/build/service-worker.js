// Nano Remote service worker (ADR 0004). Template: web/build/pwa.ts replaces the config line below with
// the build version (a hash of every shipped file) and the app shell file list, and writes /sw.js.
//
// It caches the app shell only, so a home-screen launch opens even when the host is briefly
// unreachable. It never touches /v1 (pairing, the API) or the stream, and lets anything outside the
// shell go straight to the network. A new build installs next to the old one and waits; the page asks
// the user to reload, then posts SKIP_WAITING.
/* global self, caches, fetch, Response, URL */
const VERSION = '__VERSION__';
const SHELL = [];
/* end config */

const PREFIX = 'nano-remote-shell-';
const CACHE = PREFIX + VERSION;
const INDEX = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return; // the API and the stream: never
  if (request.mode === 'navigate') {
    // Network first, so an open always gets the newest index.html; the cached shell when offline.
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match(INDEX)).then((hit) => hit || Response.error())));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((hit) => hit || fetch(request)));
});

// ---- Web Push (spec 9, ADR 0005) ----
// The host sends {title, body, url}; url is an in-app path (/s/<sessionId>). A tap opens it: in the open
// window when there is one (the page routes on the navigate message, web/src/pwa/navigate.ts), else in
// a new one. The page posts the VAPID key (web/src/pwa/push.ts) so pushsubscriptionchange can subscribe
// again while no page is open; it lives in its own cache, which activate never deletes.
const PUSH_STORE = 'nano-remote-push';
const PUSH_KEY_PATH = '/push-key';
const FALLBACK = { title: 'Nano Remote', body: 'Something on your computer needs a look.', url: '/' };

/** A same-origin path, or '/' for anything else. */
function inAppPath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function windows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'push-key' || typeof data.key !== 'string') return;
  if (event.waitUntil) event.waitUntil(caches.open(PUSH_STORE).then((cache) => cache.put(PUSH_KEY_PATH, new Response(data.key))));
});

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const shown = payload && typeof payload.title === 'string' && payload.title !== '' ? payload : FALLBACK;
  const url = inAppPath(shown.url);
  // Collapse repeats for the same thing: the push Topic when the payload names one, else the link.
  const tag = typeof shown.topic === 'string' && shown.topic !== '' ? shown.topic : url;
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: typeof shown.body === 'string' ? shown.body : '',
      data: { url },
      tag,
      renotify: false,
      icon: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = inAppPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    windows().then((list) => {
      const open = list.find((client) => client.focused) || list[0];
      if (!open) return self.clients.openWindow(url);
      open.postMessage({ type: 'navigate', url });
      return open.focus();
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  const oldKey = old && old.options && old.options.applicationServerKey;
  const storedKey = () =>
    caches
      .open(PUSH_STORE)
      .then((cache) => cache.match(PUSH_KEY_PATH))
      .then((hit) => (hit ? hit.text() : null));
  const resubscribe = event.newSubscription
    ? Promise.resolve(event.newSubscription)
    : (oldKey ? Promise.resolve(oldKey) : storedKey()).then((key) =>
        key ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null,
      );
  // Any open page sends push/subscribe with the new endpoint; a closed one does it on its next start.
  event.waitUntil(
    resubscribe
      .catch(() => null)
      .then(() => windows())
      .then((list) => list.forEach((client) => client.postMessage({ type: 'pushsubscriptionchange' }))),
  );
});
