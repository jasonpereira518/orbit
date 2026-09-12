"use client";

/**
 * One shared, polled copy of the capture job the app is watching.
 *
 * Shaped like `app-pulse-store.ts`: a module-level snapshot, `useSyncExternalStore`, and a
 * single interval that only runs while a subscriber exists AND the job is doing something
 * server-side (`ingesting`, `queued`, `extracting`, `saving`). Two subscribers share it —
 * the /capture page, and the watcher in the app shell that turns "extraction finished
 * while you were on /contacts" into a notification.
 */
import { useSyncExternalStore } from "react";
import { getCaptureJob } from "@/actions/capture-jobs";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { CaptureJobStatus } from "@/lib/capture/types";

/** Matches `POLL_INTERVAL_MS` in scan-qr-handoff and the import runner: one cadence app-wide. */
export const CAPTURE_POLL_MS = 1500;

const POLLING_STATUSES: readonly CaptureJobStatus[] = ["ingesting", "queued", "extracting", "saving"];

export type CaptureJobSnapshot = {
  job: CaptureJobView | null;
  /** The last poll error, cleared by the next good one. */
  error: string | null;
};

const EMPTY: CaptureJobSnapshot = { job: null, error: null };

let snapshot: CaptureJobSnapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: number | null = null;
let inFlight: Promise<void> | null = null;
let sequence = 0;

function set(next: Partial<CaptureJobSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
  syncTimer();
}

function shouldPoll() {
  return listeners.size > 0 && snapshot.job !== null && POLLING_STATUSES.includes(snapshot.job.status);
}

function syncTimer() {
  if (typeof window === "undefined") return;
  if (shouldPoll() && timer === null) {
    timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshCaptureJob();
    }, CAPTURE_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  } else if (!shouldPoll() && timer !== null) {
    window.clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }
}

function onVisible() {
  if (document.visibilityState === "visible") void refreshCaptureJob();
}

/** Put a job (from the page's server props, or an action's reply) in the store. */
export function seedCaptureJob(job: CaptureJobView | null, opts: { force?: boolean } = {}) {
  // A stale poll must never overwrite a newer copy: compare by update time when both
  // describe the same row. An action's reply (`force`) is authoritative regardless.
  if (!opts.force && job && snapshot.job && snapshot.job.id === job.id && snapshot.job.updatedAt > job.updatedAt) return;
  set({ job, error: null });
}

export function clearCaptureJob() {
  set({ job: null, error: null });
}

/** One poll now. Coalesced: a call while one is in flight shares its result. */
export function refreshCaptureJob(): Promise<void> {
  const current = snapshot.job;
  if (!current) return Promise.resolve();
  if (inFlight) return inFlight;
  const id = ++sequence;
  const run = getCaptureJob(current.id, current.updatedAt)
    .then((res) => {
      if (id !== sequence) return;
      if (!res.ok) {
        set({ error: res.error });
        return;
      }
      if ("unchanged" in res) {
        if (snapshot.error) set({ error: null });
        return;
      }
      seedCaptureJob(res.job);
    })
    .catch(() => {
      // Network blips: the next tick gets it.
    })
    .finally(() => {
      if (id === sequence) inFlight = null;
    });
  inFlight = run;
  return run;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  syncTimer();
  return () => {
    listeners.delete(listener);
    syncTimer();
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export function useCaptureJob(): CaptureJobSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
