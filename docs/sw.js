const CACHE = "poh-reader-v0.2-test-TEST-3";

const BASE = self.registration.scope;

const CORE_ASSETS = [
  BASE,
  BASE + "index.html",
  BASE + "style.css",
  BASE + "app.js",
  BASE + "pdf.mjs",
  BASE + "pdf.worker.min.mjs",
  BASE + "logo.png",
  BASE + "apple-touch-icon.png",
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
      Promise.all(
        keys.map((key) => key !== CACHE && caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// FETCH (cache-first for UI only)
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request);
    })
  );
});