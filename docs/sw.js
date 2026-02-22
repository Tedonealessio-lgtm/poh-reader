// GitHub Pages-safe Service Worker (scope-aware) — OFFLINE-FIRST
const CACHE = "poh-reader-cache-v6"; // bump on deploy
const BASE = new URL(self.registration.scope).pathname; // ends with "/"

const CORE_ASSETS = [
  BASE,
  BASE + "index.html",
  BASE + "style.css",
  BASE + "app.js",              // ✅ prefer no query here
  BASE + "pdf.mjs",
  BASE + "pdf.worker.min.mjs",
  BASE + "logo.png",
  BASE + "apple-touch-icon.png",
  BASE + "apple-touch-icon-v2.png",
  // BASE + "manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

// Helper: update cache in background
async function refreshCache(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(CACHE);
    await cache.put(req, res.clone());
    return res;
  } catch {
    return null;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // ✅ NAVIGATIONS: cache-first, update in background
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);

      // Always boot instantly from cache
      const cached =
        (await cache.match(BASE + "index.html", { ignoreSearch: true })) ||
        (await cache.match(BASE, { ignoreSearch: true }));

      // Kick off background update (don’t block UI)
      event.waitUntil(refreshCache(req));

      return cached || fetch(req); // final fallback
    })());
    return;
  }

  // ✅ STATIC: cache-first (ignore query strings), update in background
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(refreshCache(req));
      return cached;
    }
    // Not cached yet: try network, then cache it
    const res = await fetch(req);
    cache.put(req, res.clone());
    return res;
  })());
});