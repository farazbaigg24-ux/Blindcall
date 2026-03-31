// Blindcall Service Worker
const CACHE = 'blindcall-v1';
const OFFLINE_PAGE = '/offline.html';

// Files to cache for offline
const PRECACHE = [
  '/',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  // Skip socket.io requests — always need network
  if (e.request.url.includes('socket.io')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache successful responses
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached => cached || caches.match(OFFLINE_PAGE))
      )
  );
});
