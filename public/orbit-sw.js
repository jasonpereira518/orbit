/* Orbit service worker.
 *
 * Two jobs: desktop notifications while the app is installed or backgrounded
 * (`notificationclick`), and web push (`push`): Radar's same-day alerts, sent by the server
 * (`src/lib/push.ts`) even when no Orbit tab is open. A push carries `{ title, body, url, kind }`
 * and never a name, because a lock screen shows it to anyone nearby.
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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // Only same-origin paths open on click: a payload is the server's, but the worker trusts no URL.
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/radar";
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "Orbit";
  const body = typeof data.body === "string" ? data.body.slice(0, 240) : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
      tag: url,
      data: { url, kind: data.kind === "radar_moment" ? "radar_moment" : undefined },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/dashboard";
  const kind = event.notification.data && event.notification.data.kind;

  // `notification_clicked` through the same allow-listed beacon the page uses
  // (`src/lib/client-events.ts`): the kind only, never the text. The server validates it and
  // takes the user from the session cookie this same-origin request carries.
  if (kind) {
    event.waitUntil(
      fetch("/api/p/v", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "event", id: crypto.randomUUID(), name: "notification_clicked", props: { kind } }),
        keepalive: true,
      }).catch(() => undefined)
    );
  }

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
