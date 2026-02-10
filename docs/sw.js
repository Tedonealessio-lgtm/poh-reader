// GitHub Pages-safe Service Worker (scope-aware)
const CACHE = "poh-reader-cache-v41"; // bump this whenever you deploy changes

// Scope base, e.g. "https://.../poh-reader/"  -> BASE = "/poh-reader/"
const BASE = new URL(self.registration.scope).pathname; // ends with "/"

const CORE_ASSETS = [
  BASE,                 // ✅ cache the folder URL itself (important for iOS Home Screen launch)
  BASE + "index.html",
  BASE + "style.css",
  BASE + "app.js",
  BASE + "pdf.mjs",
  BASE + "pdf.worker.min.mjs",
  BASE + "logo.png",
  BASE + "apple-touch-icon.png",
  BASE + "apple-touch-icon-v2.png",
  // If you have it:
  // BASE + "manifest.webmanifest",
];

// INSTALL
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// ACTIVATE
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)));
      await self.clients.claim();
    })()
  );
});

// FETCH
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // ✅ Always serve app shell for navigations (critical for iOS offline launch)
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);

      // Try network first when online (so updates work)
      try {
        const net = await fetch(req);
        // Refresh cached index.html for future offline boots
        cache.put(BASE + "index.html", net.clone());
        return net;
      } catch (e) {
        // Offline: serve cached shell
        const cachedIndex = await cache.match(BASE + "index.html");
        if (cachedIndex) return cachedIndex;

        // Extra fallback: base path
        const cachedBase = await cache.match(BASE);
        if (cachedBase) return cachedBase;

        return new Response("Offline: app shell not cached", { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for static assets (works offline)
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});