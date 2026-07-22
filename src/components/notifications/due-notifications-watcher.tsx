"use client";

import { useEffect, useRef } from "react";
import { listDueNotificationItems } from "@/actions/reminders";
import {
  isDesktopNotificationsPreferred,
  hydrateDesktopNotifiedIds,
  registerNotificationServiceWorker,
  showDesktopNotification,
} from "@/lib/browser-notifications";

const POLL_MS = 90_000;

/**
 * While Orbit is open, poll for due reminders / follow-ups and surface them as
 * browser/desktop OS notifications (when permission is granted).
 * Skips SW registration and polling until desktop notifications are preferred.
 */
export function DueNotificationsWatcher() {
  const running = useRef(false);
  const swReady = useRef(false);

  useEffect(() => {
    let intervalId: number | null = null;

    async function ensureWorker() {
      if (swReady.current) return;
      await registerNotificationServiceWorker();
      swReady.current = true;
    }

    async function tick() {
      if (running.current) return;
      if (!isDesktopNotificationsPreferred()) return;

      running.current = true;
      try {
        await ensureWorker();
        await hydrateDesktopNotifiedIds();
        const items = await listDueNotificationItems();
        for (const item of items) {
          await showDesktopNotification({
            id: item.id,
            title: item.title,
            body: item.body,
            url: item.url,
          });
        }
      } catch {
        // ignore network / auth blips
      } finally {
        running.current = false;
      }
    }

    function startPolling() {
      if (intervalId != null) return;
      intervalId = window.setInterval(tick, POLL_MS);
    }

    function stopPolling() {
      if (intervalId == null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    }

    function syncFromPreference() {
      if (isDesktopNotificationsPreferred()) {
        startPolling();
        void tick();
      } else {
        stopPolling();
      }
    }

    syncFromPreference();

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "orbit:desktop-notifications") syncFromPreference();
    };
    const onPrefChange = () => syncFromPreference();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    window.addEventListener(
      "orbit:desktop-notifications-change",
      onPrefChange
    );

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "orbit:desktop-notifications-change",
        onPrefChange
      );
    };
  }, []);

  return null;
}
