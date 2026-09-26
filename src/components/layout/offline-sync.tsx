"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { refreshPulse } from "@/lib/app-pulse-store";
import { SW_PATH } from "@/lib/browser-notifications";
import { isOffline, onReconnect, useConnectivity } from "@/lib/connectivity-store";
import { OFFLINE_RUNNERS } from "@/lib/offline-actions";
import { changesLabel } from "@/lib/offline-queue";
import { configureOfflineQueue, flushOfflineQueue } from "@/lib/offline-queue-store";
import { toast } from "@/lib/toast";

/**
 * An outage long enough that the page on screen has probably drifted from the server — a
 * reminder came due, an import finished — so coming back re-renders it. A blip shorter than
 * this is not worth `router.refresh()`, which also throws away every prefetched route.
 */
const STALE_AFTER_OUTAGE_MS = 30_000;

/**
 * Renders nothing. Owns what happens when the connection comes back: send the changes
 * queued while offline, then bring what is on screen up to date.
 *
 * Mounted once per tab from the (app) layout, beside `PresenceHeartbeat`, so it runs on
 * every signed-in route including onboarding. Takes the account id so the queue it opens
 * is this account's and no one else's.
 */
export function OfflineSync({ userId }: { userId: string }) {
  const router = useRouter();
  const { lostAt } = useConnectivity();
  // Read inside the reconnect handler, which fires after the store has already reset
  // `lostAt` to null — so the last non-null value is kept here.
  const lostAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (lostAt !== null) lostAtRef.current = lostAt;
  }, [lostAt]);

  useEffect(() => configureOfflineQueue(userId, OFFLINE_RUNNERS), [userId]);

  useEffect(() => {
    // The worker that serves `/offline.html` when a page load cannot reach the network (see
    // public/orbit-sw.js). Production only: in development it would sit in front of every
    // navigation of a server that restarts all day, and a stale worker there is confusing
    // for no benefit. Idle, so it never competes with the page's own first requests.
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register(SW_PATH, { scope: "/" }).catch(() => {
        // Private windows and some managed browsers refuse workers; the app works the same.
      });
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(register, { timeout: 10_000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(register, 3_000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const sync = async (outageMs: number) => {
      const { sent, dropped } = await flushOfflineQueue();
      if (sent > 0) {
        toast.success(`Synced ${changesLabel(sent)} you made offline`, { keep: false });
      }
      if (dropped > 0) {
        toast.error(
          `${changesLabel(dropped)} made offline didn’t go through — the item may have changed since`
        );
      }
      void refreshPulse(true);
      if (sent > 0 || dropped > 0 || outageMs > STALE_AFTER_OUTAGE_MS) router.refresh();
    };

    // Changes left from an earlier visit (a reload while offline, a closed laptop).
    if (!isOffline()) void sync(0);

    return onReconnect(() => {
      const outageMs = lostAtRef.current ? Date.now() - lostAtRef.current : 0;
      lostAtRef.current = null;
      void sync(outageMs);
    });
  }, [router]);

  return null;
}
