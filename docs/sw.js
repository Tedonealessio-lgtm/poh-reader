const CACHE = "poh-reader-v3";

// Derive the base path from the service worker scope (GitHub Pages friendly)
const SCOPE = self.registration.scope;                 // e.g. https://.../poh-reader/
const BASE = new URL(SCOPE).pathname;                  // e.g. /poh-reader/
const atBase = (p) => new URL(p.replace(/^\//, ""), SCOPE).toString();

const CORE_ASSETS = [
  atBase(""),                 // BASE (acts like "/poh-reader/")
  atBase("index.html"),
  atBase("style.css"),
  atBase("app.js"),
  atBase("pdf.mjs"),
  atBase("pdf.worker.min.mjs"),
  atBase("logo.png"),
  atBase("manifest.webmanifest"),
  atBase("apple-touch-icon.png"),
  // add any other icons you actually ship
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
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

// FETCH
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Offline navigation fallback (critical for reopening the PWA offline)
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match(atBase("index.html")).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Optionally cache fetched same-origin assets
        try {
          const url = new URL(req.url);
          if (url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
        } catch (_) {}
        return res;
      });
    })
  );
});