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
