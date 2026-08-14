"use client";

import { useEffect, useRef } from "react";
import { backfillContactAvatars } from "@/actions/contacts";
import {
  dismissBackgroundJob,
  finishBackgroundJob,
  getBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";

const BATCH_PAUSE_MS = 750;
const MAX_WAIT_MS = 15 * 60_000;
const JOB_ID = "avatar-backfill";

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
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    running.current = true;

    const controller = new AbortController();

    async function run() {
      let idlePasses = 0;
      let totalSaved = 0;
      let jobStarted = false;
      const startedAt = Date.now();

      while (!controller.signal.aborted) {
        try {
          const result = await backfillContactAvatars();
          if (controller.signal.aborted) return;

          if (!jobStarted) {
            if (result.saved > 0 || result.pending > 0) {
              jobStarted = true;
              startBackgroundJob({
                id: JOB_ID,
                kind: "avatar-backfill",
                label: "Fetching LinkedIn photos",
                done: 0,
                total: result.saved + result.pending,
                startedAt,
              });
            } else if (getBackgroundJob(JOB_ID)) {
              // Nothing to do this run — clear a stale card hydrated from a
              // previous session's localStorage snapshot.
              dismissBackgroundJob(JOB_ID);
            }
          }

          if (result.saved > 0) {
            totalSaved += result.saved;
            idlePasses = 0;
            notifyAvatarsUpdated(result.savedIds ?? []);
          }

          if (jobStarted) {
            updateBackgroundJob(JOB_ID, {
              done: totalSaved,
              total: totalSaved + result.pending,
            });
          }

          if (result.pending <= 0) {
            // Nothing left — stop until the next page visit.
            if (jobStarted) {
              finishBackgroundJob(JOB_ID, {
                status: "completed",
                resultMessage: `Fetched ${totalSaved} LinkedIn photo${totalSaved === 1 ? "" : "s"}`,
              });
            }
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

          // No rate limit but still pending (failed lookups / remote downloads).
          idlePasses += 1;
          if (idlePasses >= 3 && result.saved === 0) {
            // Avoid tight loops when remaining contacts can't be resolved.
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
      // Real work stops here — don't leave a "running" card behind.
      if (getBackgroundJob(JOB_ID)?.status === "running") {
        dismissBackgroundJob(JOB_ID);
      }
    };
  }, []);

  return null;
}
