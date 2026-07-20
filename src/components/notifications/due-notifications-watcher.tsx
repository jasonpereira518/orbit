"use client";

import { useEffect, useRef } from "react";
import { listDueNotificationItems } from "@/actions/reminders";
import {
  isDesktopNotificationsPreferred,
  registerNotificationServiceWorker,
  showDesktopNotification,
} from "@/lib/browser-notifications";

const POLL_MS = 90_000;

/**
 * While Orbit is open, poll for due reminders / follow-ups and surface them as
 * browser/desktop OS notifications (when permission is granted).
 */
export function DueNotificationsWatcher() {
  const running = useRef(false);

  useEffect(() => {
    void registerNotificationServiceWorker();

    async function tick() {
      if (running.current) return;
      if (!isDesktopNotificationsPreferred()) return;

      running.current = true;
      try {
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

    void tick();
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "orbit:desktop-notifications" && e.newValue === "1") {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
