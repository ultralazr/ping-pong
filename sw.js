// Service worker: network-first for the app shell with cache fallback, so updates arrive when
// online and everything still loads offline. The speech model is NOT cached here:
// vosk-browser stores the extracted model in IndexedDB itself and never refetches it.

const CACHE = 'tt-scorer-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'rules.js',
  'speech.js',
  'voice.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/vosk.js',
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('.tar.gz')) return; // model: handled by vosk-browser
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // cache: 'no-cache' revalidates with the server (ETag), bypassing the browser's HTTP cache;
    // GitHub Pages sends max-age=600, which would otherwise delay updates by up to 10 minutes.
    const res = await Promise.race([
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
