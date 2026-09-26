/* Orbit service worker.
 *
 * Two jobs:
 * 1. Desktop notifications while the app is installed or backgrounded (`notificationclick`).
 * 2. An offline page. A navigation that cannot reach the network — a link clicked in a
 *    tunnel, a reload on dead Wi-Fi — gets Orbit's own "you're offline" page, which reloads
 *    itself when the connection is back, instead of the browser's error screen.
 *
 * Deliberately NOT a page cache. Every app page is per-account and rendered fresh; keeping
 * copies here would put one person's contacts on disk where the next person to sign in on
 * the same browser could be served them. Only `/offline.html` — static, no data — is
 * stored. Hashed `/_next/static` assets are already immutable in the HTTP cache.
 *
 * Bump OFFLINE_CACHE when offline.html changes, so installs pick up the new copy.
 */

const OFFLINE_CACHE = "orbit-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      // A failed precache must not block the notification half from installing.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("orbit-offline-") && key !== OFFLINE_CACHE)
          .map((key) => caches.delete(key))
      );
      // Lets the browser start the navigation request while the worker boots, so having a
      // worker in front of navigations costs no extra latency.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => undefined);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only top-level page loads. Everything else — RSC payloads, Server Actions, API calls,
  // assets — goes straight to the network untouched, and fails the way the page expects.
  if (request.mode !== "navigate" || request.method !== "GET") return;

  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch (err) {
        const cache = await caches.open(OFFLINE_CACHE);
        const offline = await cache.match(OFFLINE_URL);
        if (offline) return offline;
        throw err;
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
