/* Orbit service worker.
 *
 * One job: desktop notifications while the app is installed or backgrounded
 * (`notificationclick`).
 *
 * It does NOT intercept page loads. When the server is stopped or there is no internet, the
 * browser's own error page is the honest answer, so navigations go straight to the network
 * untouched. (Earlier versions served a custom `/offline.html`; the activate step below
 * clears that cache from installs that still have it.)
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith("orbit-offline-")).map((key) => caches.delete(key))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable().catch(() => undefined);
      }
      await self.clients.claim();
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
