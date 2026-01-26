// GitHub Pages-safe Service Worker (scope-aware)
const CACHE = "poh-reader-v0.3.7-clean-ask-2026-01-27"; // bump this whenever you deploy changes

// Scope base, e.g. "https://.../poh-reader/"  -> BASE = "/poh-reader/"
const BASE = new URL(self.registration.scope).pathname;

const CORE_ASSETS = [
  BASE + "index.html",
  BASE + "style.css",
  BASE + "app.js",
  BASE + "pdf.mjs",
  BASE + "pdf.worker.min.mjs",
  BASE + "logo.png",
  BASE + "apple-touch-icon.png",
  BASE + "apple-touch-icon-v2.png",
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

  // Always serve app shell for navigations (important for iOS offline reload)
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match(BASE + "index.html").then((cached) => cached || fetch(req))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});