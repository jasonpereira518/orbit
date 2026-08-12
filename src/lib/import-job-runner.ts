"use client";

import { useSyncExternalStore } from "react";
import {
  cancelImportSession,
  confirmLinkedInMessagesImport,
  getImportJobStatus,
  startLinkedInImport,
  type ImportJobStatus,
} from "@/actions/imports";
import {
  IMPORT_BATCH_SIZE,
  type ImportProgressState,
} from "@/components/imports/import-utils";
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

export type ImportJobKind = "connections" | "messages";

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

export type ImportJobInput = {
  kind: ImportJobKind;
  csvText: string;
  fileName: string;
  ids: string[];
};

type Listener = () => void;

let snapshot: ImportJobSnapshot | null = null;
const listeners = new Set<Listener>();
let beforeUnloadBound = false;
/** Job id that should stop after the current in-flight chunk. */
let cancelJobId: string | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function importJobLabel(kind: ImportJobKind) {
  return kind === "connections"
    ? "Importing LinkedIn connections"
    : "Importing LinkedIn messages";
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
        kind: next.kind === "connections" ? "connections-import" : "messages-import",
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

function onBeforeUnload(event: BeforeUnloadEvent) {
  // Connections imports run server-side and survive navigation/tab close —
  // only warn for the still-client-driven messages import.
  if (snapshot?.status === "running" && snapshot.kind !== "connections") {
    event.preventDefault();
    event.returnValue = "";
  }
}

function ensureBeforeUnload() {
  if (beforeUnloadBound || typeof window === "undefined") return;
  beforeUnloadBound = true;
  window.addEventListener("beforeunload", onBeforeUnload);
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

async function runBatches(
  ids: string[],
  label: string,
  jobId: string,
  kind: ImportJobKind,
  runChunk: (
    chunk: string[],
    opts: { importId?: string; finalize: boolean }
  ) => Promise<{ importId: string }>
): Promise<{ importId?: string; done: number; cancelled: boolean }> {
  const total = ids.length;
  const startedAt = Date.now();
  let importId: string | undefined;
  let done = 0;

  setSnapshot({
    id: jobId,
    kind,
    status: "running",
    progress: { done: 0, total, label, startedAt },
  });

  for (let i = 0; i < ids.length; i += IMPORT_BATCH_SIZE) {
    if (snapshot?.id !== jobId || isCancelRequested(jobId)) {
      return { importId, done, cancelled: true };
    }

    const chunk = ids.slice(i, i + IMPORT_BATCH_SIZE);
    // Never finalize here if we might cancel — cancel path marks the session.
    const isLast = i + IMPORT_BATCH_SIZE >= ids.length;
    const last = await runChunk(chunk, {
      importId,
      finalize: isLast && !isCancelRequested(jobId),
    });
    importId = last.importId;
    done = Math.min(i + chunk.length, total);

    if (snapshot?.id !== jobId) {
      return { importId, done, cancelled: true };
    }

    setSnapshot({
      id: jobId,
      kind,
      status: "running",
      cancelling: isCancelRequested(jobId),
      progress: {
        done,
        total,
        label,
        startedAt,
      },
    });

    if (isCancelRequested(jobId)) {
      return { importId, done, cancelled: true };
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  return { importId, done, cancelled: false };
}

type PollOutcome =
  | { outcome: "stale" }
  | { outcome: "cancelled" }
  | { outcome: "done"; status: ImportJobStatus };

/** Polls a server-owned import job's status until it leaves "processing"/"pending". */
async function pollLinkedInImportJob(
  jobId: string,
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
      kind: "connections",
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
 * Starts a background LinkedIn import that continues even if the Imports
 * page unmounts (SPA navigation). Completes with a toast via ImportJobWatcher.
 */
export function startImportJob(input: ImportJobInput) {
  if (snapshot?.status === "running") {
    throw new Error("An import is already running. Wait for it to finish.");
  }

  ensureBeforeUnload();
  cancelJobId = null;
  const jobId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const label = input.ids.length === 1 ? "person" : "people";
  const total = input.ids.length;

  // Fire-and-forget — callers should not await completion for navigation safety.
  void (async () => {
    try {
      if (input.kind === "connections") {
        const startedAt = Date.now();
        const { importId, totalRows } = await startLinkedInImport(
          input.csvText,
          input.fileName,
          input.ids
        );

        if (snapshot?.id !== jobId) return;
        setSnapshot({
          id: jobId,
          kind: "connections",
          status: "running",
          progress: { done: 0, total: totalRows, label, startedAt },
        });

        const result = await pollLinkedInImportJob(jobId, importId, label, startedAt);
        if (result.outcome === "stale") return;

        if (result.outcome === "cancelled") {
          cancelJobId = null;
          setSnapshot({
            id: jobId,
            kind: "connections",
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
            kind: "connections",
            status: "failed",
            progress: null,
            error: status.errorMessage || "Import failed",
          });
          return;
        }

        if (status.status === "cancelled") {
          setSnapshot({
            id: jobId,
            kind: "connections",
            status: "cancelled",
            progress: null,
            resultMessage: `Import stopped. ${status.rowsProcessed} of ${status.totalRows} ${label} kept.`,
          });
          return;
        }

        setSnapshot({
          id: jobId,
          kind: "connections",
          status: "completed",
          progress: null,
          resultMessage: `Imported: ${status.contactsCreated} created, ${status.contactsUpdated} updated`,
        });
        return;
      }

      let messagesImported = 0;
      let contactsCreated = 0;
      let enrichmentTotal = 0;
      const result = await runBatches(
        input.ids,
        label,
        jobId,
        "messages",
        async (chunk, opts) => {
          const res = await confirmLinkedInMessagesImport(
            input.csvText,
            input.fileName,
            chunk,
            opts
          );
          messagesImported += res.chunkMessagesImported;
          contactsCreated = res.contactsCreated;
          enrichmentTotal += res.enrichment?.contactsEnriched ?? 0;
          return res;
        }
      );
      if (snapshot?.id !== jobId) return;

      if (result.cancelled) {
        await markSessionCancelled(result.importId);
        cancelJobId = null;
        setSnapshot({
          id: jobId,
          kind: "messages",
          status: "cancelled",
          progress: null,
          resultMessage: `Import stopped. ${result.done} of ${total} ${label} kept${
            messagesImported > 0 ? ` · ${messagesImported} messages` : ""
          }.`,
        });
        return;
      }

      setSnapshot({
        id: jobId,
        kind: "messages",
        status: "completed",
        progress: null,
        resultMessage: `Imported ${messagesImported} messages · ${contactsCreated} contacts created`,
        enrichmentMessage:
          enrichmentTotal > 0
            ? `Enriched ${enrichmentTotal} contacts for chat & follow-ups`
            : undefined,
      });
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
