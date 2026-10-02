/* Offline cache for the page itself. Questions and answers are not cached here;
 * the page keeps those in localStorage so it works with no network at all.
 *
 * The page is fetched from the network first and the cache is the fallback, so
 * a new version lands on the next open. The network fetch asks the browser to
 * revalidate, because GitHub Pages serves these files with a ten minute
 * max-age and without that the browser hands the worker a stale copy: the page
 * would come back new while its script stayed old, which is worse than either.
 *
 * The fonts ship with the page as subsets (tools/make_fonts.py), so the
 * Mincho is in the shell and the look is the same offline. The gothic subset
 * is left to the runtime cache: an iPhone uses Hiragino and never asks for it.
 */
const CACHE = 'obo-d401f2f2';
const SHELL = ['./', 'index.html', 'app.css?v=d401f2f2', 'app.js?v=d401f2f2', 'schedule.js?v=d401f2f2', 'budoux-ja.js?v=d401f2f2',
               'zen-old-mincho-700.woff2', 'zen-old-mincho-600.woff2',
               'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
