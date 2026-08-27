"use client";

import { useSyncExternalStore } from "react";
import {
  cancelImportSession,
  confirmCalendarImport,
  confirmGoogleContactsImport,
  confirmOutlookContactsImport,
  getImportJobStatus,
  startLinkedInImport,
  startLinkedInMessagesImport,
  type ImportJobStatus,
} from "@/actions/imports";
import { type ImportProgressState } from "@/components/imports/import-utils";
import {
  finishBackgroundJob,
  getBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";

const POLL_INTERVAL_MS = 1500;

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export type ImportJobKind =
  | "connections"
  | "messages"
  | "google_contacts"
  | "outlook_contacts"
  | "calendar";

export type ImportJobSnapshot = {
  id: string;
  kind: ImportJobKind;
  status: "running" | "completed" | "failed" | "cancelled";
  progress: ImportProgressState | null;
  cancelling?: boolean;
  error?: string;
  resultMessage?: string;
  enrichmentMessage?: string;
};

export type ImportJobInput =
  | { kind: "connections"; csvText: string; fileName: string; ids: string[] }
  | { kind: "messages"; csvText: string; fileName: string; ids: string[] }
  | { kind: "google_contacts"; ids: string[] }
  | { kind: "outlook_contacts"; ids: string[] }
  | {
      kind: "calendar";
      calendarKind: "ics" | "csv";
      text: string;
      fileName: string;
      createFollowUps: boolean;
    };

type Listener = () => void;

let snapshot: ImportJobSnapshot | null = null;
const listeners = new Set<Listener>();
/** Job id that should stop after the current in-flight chunk. */
let cancelJobId: string | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function importJobLabel(kind: ImportJobKind) {
  switch (kind) {
    case "connections":
      return "Importing LinkedIn connections";
    case "messages":
      return "Importing LinkedIn messages";
    case "google_contacts":
      return "Importing Google contacts";
    case "outlook_contacts":
      return "Importing Outlook contacts";
    case "calendar":
      return "Importing calendar";
  }
}

/** Mirrors the singleton import snapshot into the shared multi-job store so it
 * shows up in the persistent global progress bar and the notification panel. */
function mirrorToBackgroundJobs(next: ImportJobSnapshot | null) {
  if (!next) return;
  const backgroundJobId = `import:${next.id}`;

  if (next.status === "running") {
    const done = next.progress?.done ?? 0;
    const total = next.progress?.total ?? 0;
    const startedAt = next.progress?.startedAt ?? Date.now();
    if (!getBackgroundJob(backgroundJobId)) {
      startBackgroundJob({
        id: backgroundJobId,
        kind: `${next.kind}-import`,
        label: importJobLabel(next.kind),
        done,
        total,
        startedAt,
        cancelling: next.cancelling,
        onCancel: cancelImportJob,
      });
    } else {
      updateBackgroundJob(backgroundJobId, { done, total, cancelling: next.cancelling });
    }
    return;
  }

  finishBackgroundJob(backgroundJobId, {
    status: next.status,
    resultMessage: next.resultMessage,
    error: next.error,
  });
}

function setSnapshot(next: ImportJobSnapshot | null) {
  snapshot = next;
  mirrorToBackgroundJobs(next);
  emit();
}

export function getImportJobSnapshot() {
  return snapshot;
}

export function subscribeImportJob(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearImportJob() {
  if (snapshot?.status === "running") return;
  setSnapshot(null);
}

/** Request stop after the current batch; already-imported rows are kept. */
export function cancelImportJob() {
  if (snapshot?.status !== "running") return;
  cancelJobId = snapshot.id;
  setSnapshot({ ...snapshot, cancelling: true });
}

export function useImportJob() {
  return useSyncExternalStore(
    subscribeImportJob,
    getImportJobSnapshot,
    () => null
  );
}

function isCancelRequested(jobId: string) {
  return cancelJobId === jobId;
}

async function markSessionCancelled(importId: string | undefined) {
  if (!importId) return;
  try {
    await cancelImportSession(importId);
  } catch {
    // keep local cancel state even if session update fails
  }
}

type PollOutcome =
  | { outcome: "stale" }
  | { outcome: "cancelled" }
  | { outcome: "done"; status: ImportJobStatus };

/** The subset of `ImportJobKind` that names a server-owned import — every kind as of
 *  Task 15, all processed by the resumable engine (Tasks 10-15). */
type ServerOwnedKind =
  | "connections"
  | "messages"
  | "google_contacts"
  | "outlook_contacts"
  | "calendar";

/** Polls a server-owned import job's status until it leaves "processing"/"pending". */
async function pollServerOwnedImportJob(
  jobId: string,
  kind: ServerOwnedKind,
  importId: string,
  label: string,
  startedAt: number
): Promise<PollOutcome> {
  while (true) {
    if (snapshot?.id !== jobId) return { outcome: "stale" };

    let status: ImportJobStatus;
    try {
      status = await getImportJobStatus(importId);
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (status.status !== "processing" && status.status !== "pending") {
      return { outcome: "done", status };
    }

    if (snapshot?.id !== jobId) return { outcome: "stale" };

    setSnapshot({
      id: jobId,
      kind,
      status: "running",
      cancelling: isCancelRequested(jobId),
      progress: {
        done: status.rowsProcessed,
        total: status.totalRows,
        label,
        startedAt,
      },
    });

    if (isCancelRequested(jobId)) {
      await markSessionCancelled(importId);
      return { outcome: "cancelled" };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Starts a server-owned import job (LinkedIn connections, Google contacts, Outlook
 * contacts — anything the resumable engine drives) and polls it to completion, updating
 * the shared snapshot as it goes. `start` is expected to insert the `imports`/
 * `import_job_rows` snapshot and kick the background run, exactly like `startLinkedInImport`
 * and the `confirm*ContactsImport` actions do.
 *
 * The snapshot is seeded as `running` *before* `start()` is awaited, not after. `start()` is
 * the caller's async action call — the first `await` in this function — so if nothing sets
 * the snapshot until after it resolves, every check further down that guards on
 * `snapshot?.id !== jobId` (including the one in `pollServerOwnedImportJob`, and the
 * catch-all in `startImportJob`) sees the *pre-import* snapshot: `null` initially, or a
 * stale id left over from a previous job (`clearImportJob` only nulls it out ~50ms after a
 * terminal job, not synchronously). Either way `snapshot?.id !== jobId` is true, so the
 * function returns immediately after `start()` resolves — no progress, no poll, no
 * completion toast, and any error `start()` throws is swallowed by the same guard in the
 * `catch` block below. Seeding first closes that gap: by the time `start()`'s promise
 * settles (success or throw), `snapshot.id` already equals `jobId`. `totalRows` isn't known
 * yet at seed time, so the caller's own `ids.length` (`total`) stands in until the
 * post-`start()` `setSnapshot` corrects it with the server's real count.
 */
async function runServerOwnedImportJob(
  jobId: string,
  kind: ServerOwnedKind,
  label: string,
  total: number,
  start: () => Promise<{ importId: string; totalRows: number }>
): Promise<void> {
  const startedAt = Date.now();
  setSnapshot({
    id: jobId,
    kind,
    status: "running",
    progress: { done: 0, total, label, startedAt },
  });

  const { importId, totalRows } = await start();

  if (snapshot?.id !== jobId) return;
  setSnapshot({
    id: jobId,
    kind,
    status: "running",
    progress: { done: 0, total: totalRows, label, startedAt },
  });

  const result = await pollServerOwnedImportJob(jobId, kind, importId, label, startedAt);
  if (result.outcome === "stale") return;

  if (result.outcome === "cancelled") {
    cancelJobId = null;
    setSnapshot({
      id: jobId,
      kind,
      status: "cancelled",
      progress: null,
      resultMessage: `Import stopped.`,
    });
    return;
  }

  const status = result.status;
  if (status.status === "failed") {
    setSnapshot({
      id: jobId,
      kind,
      status: "failed",
      progress: null,
      error: status.errorMessage || "Import failed",
    });
    return;
  }

  if (status.status === "cancelled") {
    setSnapshot({
      id: jobId,
      kind,
      status: "cancelled",
      progress: null,
      resultMessage: `Import stopped. ${status.rowsProcessed} of ${status.totalRows} ${label} kept.`,
    });
    return;
  }

  setSnapshot({
    id: jobId,
    kind,
    status: "completed",
    progress: null,
    resultMessage: `Imported: ${status.contactsCreated} created, ${status.contactsUpdated} updated`,
  });
}

/**
 * Starts a background LinkedIn import that continues even if the Imports
 * page unmounts (SPA navigation). Completes with a toast via ImportJobWatcher.
 */
export function startImportJob(input: ImportJobInput) {
  if (snapshot?.status === "running") {
    throw new Error("An import is already running. Wait for it to finish.");
  }

  cancelJobId = null;
  const jobId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Calendar has no `ids` — a whole file is confirmed at once, not a selected subset — so
  // it seeds a placeholder total of 1 "event" here; `runServerOwnedImportJob` corrects it to
  // the server's real row count (pairs, not events — see `CalendarEventRowPayload`) right
  // after `start()` resolves, same as every other kind's placeholder gets corrected.
  const label = input.kind === "calendar" ? "event" : input.ids.length === 1 ? "person" : "people";
  const total = input.kind === "calendar" ? 1 : input.ids.length;

  // Fire-and-forget — callers should not await completion for navigation safety.
  void (async () => {
    try {
      if (input.kind === "connections") {
        await runServerOwnedImportJob(jobId, "connections", label, total, () =>
          startLinkedInImport(input.csvText, input.fileName, input.ids)
        );
        return;
      }

      if (input.kind === "google_contacts") {
        await runServerOwnedImportJob(jobId, "google_contacts", label, total, () =>
          confirmGoogleContactsImport(input.ids)
        );
        return;
      }

      if (input.kind === "outlook_contacts") {
        await runServerOwnedImportJob(jobId, "outlook_contacts", label, total, () =>
          confirmOutlookContactsImport(input.ids)
        );
        return;
      }

      if (input.kind === "messages") {
        await runServerOwnedImportJob(jobId, "messages", label, total, () =>
          startLinkedInMessagesImport(input.csvText, input.fileName, input.ids)
        );
        return;
      }

      if (input.kind === "calendar") {
        await runServerOwnedImportJob(jobId, "calendar", "event", 1, () =>
          confirmCalendarImport({
            kind: input.calendarKind,
            text: input.text,
            fileName: input.fileName,
            createFollowUps: input.createFollowUps,
          })
        );
        return;
      }
    } catch (err) {
      if (snapshot?.id !== jobId) return;
      cancelJobId = null;
      setSnapshot({
        id: jobId,
        kind: input.kind,
        status: "failed",
        progress: null,
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  })();

  return jobId;
}
