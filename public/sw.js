/*
 * Minimal service worker. It exists for one reason: so the worker can OPEN the
 * app with no network at all.
 *
 * Without it the queue still survives a hard close - it is in IndexedDB - but a
 * cold launch in a market with no signal cannot even load the page to show it.
 * That is not much use to someone standing in an outlet with no bars.
 *
 * Strategy is network-first for everything, falling back to the cache. It is
 * the boring choice on purpose: the worker always gets the current version when
 * there is signal, and a stale shell can never outlive a deploy. The cost is
 * that it does nothing for speed, which is not what this is for.
 *
 * /api/ is never cached. A queued report must reach the real server or fail
 * honestly - a cached 201 would be the exact lie this whole app avoids telling.
 */

const CACHE = 'field-reports-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cached, never faked

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // A navigation we have never seen falls back to the cached shell.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return new Response('offline', { status: 503, statusText: 'offline' });
      })
  );
});
