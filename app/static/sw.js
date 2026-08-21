/* Revenue Tracker — service worker
   Strategy:
   - Navigations (HTML shell): NETWORK-FIRST — always fetch fresh HTML, fall
     back to cache only when offline. This guarantees every load picks up the
     latest version (no stale installed-PWA shells).
   - Static assets (/styles.css?v=…, /app.js?v=…, icons, manifest):
     cache-first; they are cache-busted with ?v= so updates reach the browser
     via new URLs.
   - API calls (/api/*, /healthz): NEVER cached — always network, data stays
     fresh and private. Only 200 responses are ever stored — never 401s — so
     the basic-auth gate can't be poisoned.
*/
const CACHE = "revenue-v4";
const SHELL = ["/", "/styles.css", "/app.js", "/manifest.webmanifest",
               "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API + healthz: network only
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  // HTML navigations: network-first (fresh shell every load), cache fallback offline
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});