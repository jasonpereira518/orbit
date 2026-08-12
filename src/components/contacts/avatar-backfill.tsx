"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { backfillContactAvatars } from "@/actions/contacts";

const BATCH_PAUSE_MS = 750;
const MAX_WAIT_MS = 15 * 60_000;

export const AVATARS_UPDATED_EVENT = "orbit:avatars-updated";

export type AvatarsUpdatedDetail = {
  contactIds: string[];
};

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => resolve(), ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function notifyAvatarsUpdated(contactIds: string[]) {
  if (typeof window === "undefined" || contactIds.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<AvatarsUpdatedDetail>(AVATARS_UPDATED_EVENT, {
      detail: { contactIds },
    })
  );
}

/**
 * Quietly fills missing LinkedIn photos in the background.
 * Soft-updates the UI via `orbit:avatars-updated` instead of a full
 * `router.refresh()` so browsing stays smooth.
 */
export function AvatarBackfill() {
  const pathname = usePathname();
  const running = useRef(false);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (running.current) return;
    running.current = true;

    const controller = new AbortController();

    async function run() {
      let idlePasses = 0;

      while (!controller.signal.aborted) {
        try {
          const result = await backfillContactAvatars();
          if (controller.signal.aborted) return;

          if (result.saved > 0) {
            idlePasses = 0;
            const ids = result.savedIds ?? [];
            notifyAvatarsUpdated(ids);
          }

          if (result.pending <= 0) {
            return;
          }

          if (result.rateLimitedUntil && result.rateLimitedUntil > Date.now()) {
            const wait = Math.min(
              MAX_WAIT_MS,
              Math.max(5_000, result.rateLimitedUntil - Date.now() + 1_000)
            );
            await sleep(wait, controller.signal);
            continue;
          }

          idlePasses += 1;
          if (idlePasses >= 3 && result.saved === 0) {
            await sleep(60_000, controller.signal);
            idlePasses = 0;
            continue;
          }

          await sleep(BATCH_PAUSE_MS, controller.signal);
        } catch {
          await sleep(30_000, controller.signal);
        }
      }
    }

    void run();

    return () => {
      controller.abort();
      running.current = false;
    };
  }, []);

  return null;
}
