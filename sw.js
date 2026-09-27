/* Pet Health Tracker PWA service worker.
   This caches only the same-origin app shell. Health data remains in the
   app's existing localStorage / Firestore paths; the service worker never
   reads or writes it. */
const SHELL_CACHE = 'pet-health-shell-6.5';
const RUNTIME_CACHE = 'pet-health-runtime-6.5';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=6.5',
  './app.js?v=6.5',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key =>
        (key.startsWith('pet-health-shell-') && key !== SHELL_CACHE) ||
        (key.startsWith('pet-health-runtime-') && key !== RUNTIME_CACHE)
      ).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // version.json must always come from the network so the app's existing
  // release/update check cannot be hidden by the offline shell cache.
  if (sameOrigin && url.pathname.endsWith('/version.json')) return;

  if (sameOrigin && request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Cache static assets only. This can include the pinned Chart/Firebase CDN
  // scripts and Google Fonts after an online launch, but never Firestore/API
  // requests (their request.destination is empty).
  const cacheable = ['style', 'script', 'image', 'manifest', 'font'].includes(request.destination);
  if (!cacheable) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(sameOrigin ? SHELL_CACHE : RUNTIME_CACHE)
            .then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
