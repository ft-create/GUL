/* GUL — offline shell. Cache-first for the app's own files,
   network-first for navigations; the cloud syncs when it can. */
/* Bump this on every deploy that changes a shell asset. The install
   handler precaches SHELL under this name, so a stale name means a
   returning visitor keeps the old app even after a successful deploy. */
const V = '31';
const CACHE = `gul-web-v${V}`;
/* The version has to be ON the precached names. The page asks for
   ./app.js?v=31; Cache API matching is query-sensitive and ignoreSearch is
   not set, so a bare './app.js' in here never matches what the page
   requests. The old list therefore downloaded the whole app twice on a
   first visit and — worse — a first-time installer who went offline before
   a second visit got an unstyled skeleton, because every versioned request
   missed the cache and there was no network to fall back to.

   This is the fifth version marker. It moves with the other four. */
const SHELL = [
  './', './index.html', `./styles.css?v=${V}`, `./app.js?v=${V}`,
  `./firebase.js?v=${V}`, `./cities.js?v=${V}`, `./solar.js?v=${V}`,
  `./install.js?v=${V}`, `./tzdata.js?v=${V}`, './favicon.svg', './gul-mark.svg',
  './app-icon.svg', './maskable-icon.svg', './manifest.webmanifest',
  /* The Home Screen icons. Precached so the install card and the sheet
     draw instantly and still draw offline. */
  './icons/apple-touch-icon.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-512-maskable.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      /* Only ever delete our OWN old caches. GUL and IRONCADE share the
         origin experiment.fareedtareen.com, so caches.keys() returns both
         apps' caches to both service workers. A blanket "delete everything
         that is not mine" meant each app wiped the other's shell on every
         activation — two apps quietly destroying each other's offline copy
         all day. The prefix is the whole fix. */
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('gul-web-') && k !== CACHE)
            .map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Firebase or fonts API calls — let them hit the network.
  if (url.hostname.includes('googleapis.com') && !url.hostname.includes('gstatic')) return;
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit),
    ),
  );
});
