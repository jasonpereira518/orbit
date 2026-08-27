"use client";

import { useSyncExternalStore } from "react";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export type BackgroundJob = {
  id: string;
  /** Stable category for icons/grouping, e.g. "connections-import", "avatar-backfill". */
  kind: string;
  /** Short human label, e.g. "Importing LinkedIn connections". */
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
  /** Swiped away from the bottom-right widget — still tracked (and shown in
   * the notification center) until it finishes and auto-removes. */
  hiddenFromWidget?: boolean;
};

const AUTO_REMOVE_MS = 6000;

const jobs = new Map<string, BackgroundJob>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let cachedList: BackgroundJob[] = [];

function recompute() {
  cachedList = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function emit() {
  recompute();
  for (const listener of listeners) listener();
}

function clearAutoRemove(id: string) {
  const timer = timers.get(id);
  if (timer != null) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/** Register a new running job. Returns the job id for convenience (same as job.id). */
export function startBackgroundJob(
  job: Omit<BackgroundJob, "status" | "done" | "total"> & {
    done?: number;
    total?: number;
  }
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
  }
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
    }, AUTO_REMOVE_MS)
  );
}

export function dismissBackgroundJob(id: string) {
  clearAutoRemove(id);
  if (!jobs.has(id)) return;
  jobs.delete(id);
  emit();
}

/** Swipe-dismiss from the bottom-right widget only — the job keeps running
 * (or stays in its terminal state) and remains visible in the notification
 * center's Tasks section until it finishes and auto-removes. */
export function hideBackgroundJobFromWidget(id: string) {
  updateBackgroundJob(id, { hiddenFromWidget: true });
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

const EMPTY_JOBS: BackgroundJob[] = [];

function getServerSnapshot(): BackgroundJob[] {
  return EMPTY_JOBS;
}

/** All tracked jobs (running + recently finished), newest first. */
export function useBackgroundJobs(): BackgroundJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useActiveBackgroundJobCount(): number {
  const list = useBackgroundJobs();
  return list.filter((job) => job.status === "running").length;
}
