// ============================================================================
// MURLAN — service worker (registered in PRODUCTION ONLY; see main.tsx)
// ----------------------------------------------------------------------------
// Deliberately conservative for a real-money app:
//   • Never touches non-GET requests, cross-origin requests, or /api · /socket.io
//     — money, auth, and the live game socket always go straight to the network.
//   • Navigations are NETWORK-FIRST (an online user always gets fresh HTML), with
//     the cached shell only as an offline fallback — so a deploy is never stale.
//   • Content-hashed static assets (/assets/*) are cache-first (their names change
//     on every deploy, so a cached copy can never be stale).
// ============================================================================

const CACHE = 'murlan-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POST/webhooks/etc.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // leave cross-origin alone
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return; // never cache API/socket

  if (req.mode === 'navigate') {
    // Network-first: fresh shell when online; cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return res; })
        .catch(() => caches.match('/').then((m) => m || Response.error())),
    );
    return;
  }

  // Cache-first for hashed static assets / the manifest / the icon.
  const cacheable = url.pathname.startsWith('/assets/') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest');
  if (!cacheable) return;
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }),
    ),
  );
});

// ---- Web Push re-engagement (turn / match / reward nudges) -----------------
// Show the notification the server sent. Payload is JSON { title, body, url, tag };
// a non-JSON payload falls back to plain text so a malformed push still shows.
self.addEventListener('push', (event) => {
  let data = { title: 'Murlan', body: '', url: '/', tag: undefined };
  try { if (event.data) data = { ...data, ...event.data.json() }; }
  catch { if (event.data) data.body = event.data.text(); }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: data.url || '/' },
    }),
  );
});

// Clicking a notification focuses an existing tab (or opens one) at the deep link.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) { client.navigate(target).catch(() => {}); return client.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
