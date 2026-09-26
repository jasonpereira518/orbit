"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, Wifi, WifiOff } from "lucide-react";
import {
  onReconnect,
  retryConnectionNow,
  useConnectivity,
} from "@/lib/connectivity-store";
import type { ConnectivityStatus } from "@/lib/connectivity";
import { changesLabel } from "@/lib/offline-queue";
import { useOfflineQueue } from "@/lib/offline-queue-store";
import { cn } from "@/lib/utils";

/** How long "Back online" stays up after the connection returns. */
const RESTORED_MS = 2_500;

type Shown = ConnectivityStatus | "restored";

/**
 * The strip across the top of the app that says, plainly, when Orbit cannot be reached —
 * and that it is back.
 *
 * In-flow at the top of the shell, like `ViewAsUserBanner`: it pushes the page down a line
 * rather than covering the mobile header's buttons or the first row of a list. It is only
 * there while something is wrong (plus a moment of "Back online"), so the shift is the
 * signal, not a cost.
 *
 * Two different states on purpose. `offline` is the device's own verdict and the remedy is
 * the person's (find Wi-Fi); `unreachable` means the device has a network but Orbit is not
 * answering it, where "check your connection" would be the wrong advice and a retry is the
 * useful control.
 *
 * The live region is the always-mounted wrapper, not the strip: a region that appears in the
 * same commit as its text is not reliably announced.
 */
export function ConnectivityBanner() {
  const { status } = useConnectivity();
  const pending = useOfflineQueue().length;
  const [restored, setRestored] = useState(false);
  const [checking, setChecking] = useState(false);

  // "Back online" for a moment after a reconnection. A lingering `restored` from an earlier
  // one is harmless: any non-online status outranks it below.
  useEffect(() => {
    let timer: number | undefined;
    const stop = onReconnect(() => {
      setRestored(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRestored(false), RESTORED_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  const shown: Shown | null = status !== "online" ? status : restored ? "restored" : null;

  const waiting = pending > 0 ? `${changesLabel(pending)} waiting to sync` : null;

  return (
    <div role="status" aria-live="polite" className="shrink-0">
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="connectivity"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "flex items-center justify-center gap-3 border-b px-4 py-1.5 text-xs transition-colors",
                shown === "restored"
                  ? "border-success/30 bg-success/12 text-success"
                  : shown === "unreachable"
                    ? "border-warning/40 bg-warning/15 text-warning"
                    : "border-border/70 bg-muted text-foreground"
              )}
            >
              {shown === "offline" && <WifiOff className="size-3.5 shrink-0" aria-hidden />}
              {shown === "unreachable" && <CloudOff className="size-3.5 shrink-0" aria-hidden />}
              {shown === "restored" && <Wifi className="size-3.5 shrink-0" aria-hidden />}
              <p className="min-w-0 truncate">
                <span className="font-medium">
                  {shown === "offline"
                    ? "You’re offline"
                    : shown === "unreachable"
                      ? "Can’t reach Orbit"
                      : "Back online"}
                </span>
                {shown === "offline" && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {waiting ?? (
                      <>
                        <span className="sm:hidden">showing what’s already loaded</span>
                        <span className="hidden sm:inline">
                          you can keep reading what’s already loaded
                        </span>
                      </>
                    )}
                  </span>
                )}
                {shown === "unreachable" && (
                  <span className="opacity-80">
                    {" · "}
                    {waiting ?? "retrying on its own"}
                  </span>
                )}
              </p>
              {shown === "unreachable" && (
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => {
                    setChecking(true);
                    void retryConnectionNow().finally(() => setChecking(false));
                  }}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning transition-colors hover:bg-warning/25 disabled:opacity-60"
                >
                  <RefreshCw className={cn("size-3", checking && "animate-spin")} aria-hidden />
                  {checking ? "Checking…" : "Retry now"}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
