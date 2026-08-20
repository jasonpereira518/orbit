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
/** Passes with no progress at all before we stop for this page load. */
const MAX_IDLE_PASSES = 3;
const JOB_ID = "avatar-backfill";
const LABEL = "Fetching LinkedIn photos";

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

function summarize(saved: number, unresolved: number) {
  const photos = `Fetched ${saved} LinkedIn photo${saved === 1 ? "" : "s"}`;
  if (unresolved === 0) return photos;
  return `${photos} · no public photo for ${unresolved}`;
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
      let total = 0;
      // Contacts we've already tried and couldn't resolve. Without this the
      // action keeps handing back the same unresolvable batch and the job
      // sits at 0% forever instead of working through the backlog.
      const unresolved = new Set<string>();
      const startedAt = Date.now();

      function progress() {
        if (!jobStarted) return;
        updateBackgroundJob(JOB_ID, {
          label: LABEL,
          done: totalSaved + unresolved.size,
          total,
        });
      }

      while (!controller.signal.aborted) {
        try {
          const result = await backfillContactAvatars({
            skipIds: Array.from(unresolved),
          });
          if (controller.signal.aborted) return;

          if (!jobStarted) {
            // saved + failedIds + pending is exactly this pass's backlog, and
            // on the first pass nothing is skipped yet — so that's the total.
            const backlog =
              result.saved + result.failedIds.length + result.pending;
            if (backlog > 0) {
              jobStarted = true;
              total = backlog;
              startBackgroundJob({
                id: JOB_ID,
                kind: "avatar-backfill",
                label: LABEL,
                done: 0,
                total,
                startedAt,
              });
            } else if (getBackgroundJob(JOB_ID)) {
              // Nothing to do this run — clear a card left by an earlier pass.
              dismissBackgroundJob(JOB_ID);
            }
          }

          if (result.storageError) {
            // Photo storage is broken, so every remaining contact would fail
            // the same way. Say so instead of spinning at 0%.
            if (jobStarted) {
              finishBackgroundJob(JOB_ID, {
                status: "failed",
                resultMessage: "Couldn't save LinkedIn photos",
                error: result.storageError,
              });
            }
            console.error("[avatars] %s", result.storageError);
            return;
          }

          const madeProgress = result.saved > 0 || result.failedIds.length > 0;

          if (result.saved > 0) {
            totalSaved += result.saved;
            notifyAvatarsUpdated(result.savedIds ?? []);
          }
          for (const id of result.failedIds) unresolved.add(id);

          idlePasses = madeProgress ? 0 : idlePasses + 1;
          progress();

          if (result.pending <= 0) {
            // Nothing left — stop until the next page load.
            if (jobStarted) {
              finishBackgroundJob(JOB_ID, {
                status: "completed",
                resultMessage: summarize(totalSaved, unresolved.size),
              });
            }
            return;
          }

          if (result.rateLimitedUntil && result.rateLimitedUntil > Date.now()) {
            const wait = Math.min(
              MAX_WAIT_MS,
              Math.max(5_000, result.rateLimitedUntil - Date.now() + 1_000)
            );
            if (jobStarted) {
              updateBackgroundJob(JOB_ID, {
                label: `${LABEL} (waiting on rate limit)`,
              });
            }
            await sleep(wait, controller.signal);
            continue;
          }

          if (idlePasses >= MAX_IDLE_PASSES) {
            // Nothing is moving and we aren't rate limited — retrying just
            // burns requests. Report what we got and pick this up next load.
            if (jobStarted) {
              finishBackgroundJob(JOB_ID, {
                status: "completed",
                resultMessage: summarize(totalSaved, unresolved.size),
              });
            }
            return;
          }

          await sleep(BATCH_PAUSE_MS, controller.signal);
        } catch (err) {
          idlePasses += 1;
          if (idlePasses >= MAX_IDLE_PASSES) {
            if (jobStarted) {
              finishBackgroundJob(JOB_ID, {
                status: "failed",
                resultMessage: "Couldn't fetch LinkedIn photos",
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }
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
