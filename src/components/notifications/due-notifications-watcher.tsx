"use client";

import { useEffect, useRef } from "react";
import { useAppPulse } from "@/lib/app-pulse-store";
import {
  isDesktopNotificationsPreferred,
  hydrateDesktopNotifiedIds,
  registerNotificationServiceWorker,
  showDesktopNotification,
  syncDesktopNotificationsPreference,
} from "@/lib/browser-notifications";

/**
 * While Orbit is open, surface due reminders / follow-ups as browser/desktop OS
 * notifications (when permission is granted).
 *
 * No timer of its own: the app pulse (`src/lib/app-pulse-store.ts`) already carries the
 * due items not yet shown, so this only reacts when a pulse lands. It used to poll on its
 * own every 90 s and re-fetch the whole notifications panel to find the same items.
 */
export function DueNotificationsWatcher() {
  const { pulse } = useAppPulse();
  const running = useRef(false);
  const swReady = useRef(false);
  const dueItems = pulse?.dueItems;
  const accountPreference = pulse?.desktopNotificationsEnabled;

  // Before the delivery effect below, so a pulse that both turns notifications off (from
  // another device) and carries due items is read with the new preference, not the old.
  useEffect(() => {
    if (accountPreference === undefined) return;
    syncDesktopNotificationsPreference(accountPreference);
  }, [accountPreference]);

  useEffect(() => {
    if (!dueItems || dueItems.length === 0) return;
    if (running.current) return;
    if (!isDesktopNotificationsPreferred()) return;

    let cancelled = false;
    running.current = true;
    (async () => {
      try {
        if (!swReady.current) {
          await registerNotificationServiceWorker();
          swReady.current = true;
        }
        await hydrateDesktopNotifiedIds();
        for (const item of dueItems) {
          if (cancelled) break;
          await showDesktopNotification({
            id: item.id,
            title: item.title,
            body: item.body,
            url: item.url,
          });
        }
      } catch {
        // ignore permission / network blips; the next pulse tries again
      } finally {
        running.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dueItems]);

  return null;
}
