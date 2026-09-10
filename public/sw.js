/**
 * Service worker: makes the game installable and playable offline.
 *
 * The page shell is fetched network-first so a new deploy shows up on the
 * next launch; everything else — the hashed bundles, the models, textures,
 * skies, sounds and fonts — is cached on first use and served from the cache
 * after that. Nothing here is precached, so the first visit is no heavier
 * than it was.
 */
/*
 * Bump this whenever a file that is *not* content-hashed changes — the models,
 * textures, skies and sounds under assets/, which are cached first-hit and
 * served from the cache forever after. The bundles are hashed by the build and
 * look after themselves; these do not.
 *
 * v2: the trackside props shipped with 4269-pixel textures, three of them
 * carrying 208 MB of decoded image each. A phone that loaded that build has
 * them cached at a URL that has not changed, so without this bump the fix
 * never reaches it — it keeps serving the version that kills the tab.
 */
const CACHE = 'apex-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isShell = request.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && (response.type === 'basic' || response.type === 'default')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
