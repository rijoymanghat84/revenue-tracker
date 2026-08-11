/* Revenue Tracker — service worker
   Strategy:
   - Static app shell (/, /styles.css, /app.js, /manifest.webmanifest, icons):
     cache-first once fetched successfully (they are cache-busted with ?v= so
     updates always reach the browser via a new URL).
   - API calls (/api/*, /healthz): NEVER cached — always network, so data is
     always fresh and private. Offline, API calls fail gracefully.
   - Only 200 responses are ever stored — never 401s, so the basic-auth gate
     can't be poisoned into an offline "login required" loop.
*/
const CACHE = "revenue-v1";
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
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API + healthz: network only
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  // Static shell: cache-first
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