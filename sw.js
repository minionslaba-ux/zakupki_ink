// Service worker для установки Shtark INK Flow как приложения (PWA).
// Стратегия: сеть в приоритете, кэш — как резерв для офлайн-открытия.
const CACHE = 'inkflow-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => { try { const c = resp.clone(); caches.open(CACHE).then((cache) => cache.put(e.request, c)); } catch (x) {} return resp; })
      .catch(() => caches.match(e.request))
  );
});
