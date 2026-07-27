/**
 * Service worker.
 *
 * Its job here is startup speed and installability, NOT offline notes. Notes live
 * only on the server, so serving a cached note would be a lie: the person would
 * read something that may have changed, with no way to tell. Anything under
 * `/api/` therefore never touches the cache, in either direction.
 *
 * Assets are content-hashed by the bundler, so caching them permanently is safe.
 * The page shell is fetched from the network first and only falls back to cache,
 * because a stale shell after a deploy means an app talking to an API it no
 * longer matches.
 */

const CACHE = 'ndbrain-shell-v1';

/** Only these are worth having before the first request. */
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // A failed precache must not block activation — the app works without it.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache data, and never answer a data request from cache.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, cache as a fallback for a dead connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Hashed assets: cache first, since their name changes when they do.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
