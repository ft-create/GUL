/* GUL — offline shell. Cache-first for the app's own files,
   network-first for navigations; the cloud syncs when it can. */
/* Bump this on every deploy that changes a shell asset. The install
   handler precaches SHELL under this name, so a stale name means a
   returning visitor keeps the old app even after a successful deploy. */
const CACHE = 'gul-web-v19';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './firebase.js',
  './cities.js', './solar.js', './favicon.svg', './gul-mark.svg',
  './app-icon.svg', './maskable-icon.svg', './manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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
