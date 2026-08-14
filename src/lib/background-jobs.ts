"use client";

import { useSyncExternalStore } from "react";

export type BackgroundJobStatus =
  "running" | "completed" | "failed" | "cancelled";

export type BackgroundJob = {
  id: string;
  /** Stable category for icons/grouping, e.g. "avatar-backfill". */
  kind: string;
  /** Short human label, e.g. "Fetching LinkedIn photos". */
  label: string;
  status: BackgroundJobStatus;
  /** Set both to 0 for an indeterminate (spinner-only) job. */
  done: number;
  total: number;
  startedAt: number;
  resultMessage?: string;
  error?: string;
  cancelling?: boolean;
  onCancel?: () => void;
};

const AUTO_REMOVE_MS = 6000;
const STORAGE_KEY = "orbit:background-jobs";
/** Discard a persisted "running" job if nothing has refreshed it in this long —
 * a real run always re-confirms itself within seconds of mounting. */
const STALE_MS = 10 * 60_000;

const jobs = new Map<string, BackgroundJob>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let cachedList: BackgroundJob[] = [];

function persist() {
  if (typeof window === "undefined") return;
  try {
    const running = Array.from(jobs.values()).filter(
      (job) => job.status === "running",
    );
    if (running.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    // Functions aren't serializable — restored jobs are read-only until a
    // real update from the actual run arrives and replaces them.
    const serializable = running.map(
      ({ onCancel: _onCancel, ...rest }) => rest,
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // best-effort — a full/unavailable store shouldn't break job tracking
  }
}

function hydrate() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as BackgroundJob[];
    const now = Date.now();
    for (const job of parsed) {
      if (now - job.startedAt > STALE_MS) continue;
      jobs.set(job.id, job);
    }
    recompute();
  } catch {
    // ignore malformed storage
  }
}

function recompute() {
  cachedList = Array.from(jobs.values()).sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

function emit() {
  recompute();
  persist();
  for (const listener of listeners) listener();
}

function clearAutoRemove(id: string) {
  const timer = timers.get(id);
  if (timer != null) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

// Hydrate from the last known snapshot before the first render, so a page
// reload shows the card immediately instead of waiting on a network round trip.
hydrate();

/** Register a new running job. Returns the job id for convenience (same as job.id). */
export function startBackgroundJob(
  job: Omit<BackgroundJob, "status" | "done" | "total"> & {
    done?: number;
    total?: number;
  },
) {
  clearAutoRemove(job.id);
  jobs.set(job.id, {
    status: "running",
    done: job.done ?? 0,
    total: job.total ?? 0,
    ...job,
  });
  emit();
  return job.id;
}

/** Patch a running job's progress/label without changing its status. */
export function updateBackgroundJob(id: string, patch: Partial<BackgroundJob>) {
  const existing = jobs.get(id);
  if (!existing) return;
  jobs.set(id, { ...existing, ...patch });
  emit();
}

/** Move a job to a terminal state; auto-removed from the UI after a short grace period. */
export function finishBackgroundJob(
  id: string,
  patch: Omit<Partial<BackgroundJob>, "status"> & {
    status: Exclude<BackgroundJobStatus, "running">;
  },
) {
  const existing = jobs.get(id);
  if (!existing) return;
  jobs.set(id, { ...existing, ...patch, cancelling: false });
  emit();

  clearAutoRemove(id);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      dismissBackgroundJob(id);
    }, AUTO_REMOVE_MS),
  );
}

export function dismissBackgroundJob(id: string) {
  clearAutoRemove(id);
  if (!jobs.has(id)) return;
  jobs.delete(id);
  emit();
}

export function getBackgroundJob(id: string) {
  return jobs.get(id) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return cachedList;
}

function getServerSnapshot(): BackgroundJob[] {
  return [];
}

/** All tracked jobs (running + recently finished), newest first. */
export function useBackgroundJobs(): BackgroundJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
