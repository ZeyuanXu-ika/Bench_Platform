const CACHE = 'bench-platform-code-v2';
const FILES = ['./', './index.html', './styles.css', './graph-ui.css', './app.mjs', './core.mjs', './graph.mjs', './graph-ui.mjs', './storage.mjs', './favicon.svg', './README.md'];
const ALLOWED = new Set(FILES.map(x => new URL(x, self.registration.scope).pathname));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ALLOWED.has(url.pathname)) return;
  event.respondWith(fetch(event.request).then(async response => {
    if (response.ok) { const cache = await caches.open(CACHE); await cache.put(event.request, response.clone()); }
    return response;
  }).catch(async () => (await (await caches.open(CACHE)).match(event.request)) || new Response('请联网打开标注页面一次，以缓存网页程序。', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } })));
});
