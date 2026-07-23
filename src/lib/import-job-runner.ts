"use client";

import { useSyncExternalStore } from "react";
import {
  cancelImportSession,
  confirmLinkedInImport,
  confirmLinkedInMessagesImport,
} from "@/actions/imports";
import {
  IMPORT_BATCH_SIZE,
  type ImportProgressState,
} from "@/components/imports/import-utils";

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

function setSnapshot(next: ImportJobSnapshot | null) {
  snapshot = next;
  emit();
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (snapshot?.status === "running") {
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

export function isImportJobRunning() {
  return snapshot?.status === "running";
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
        let contactsCreated = 0;
        let contactsUpdated = 0;
        const result = await runBatches(
          input.ids,
          label,
          jobId,
          "connections",
          async (chunk, opts) => {
            const res = await confirmLinkedInImport(
              input.csvText,
              input.fileName,
              chunk,
              opts
            );
            contactsCreated = res.contactsCreated;
            contactsUpdated = res.contactsUpdated;
            return res;
          }
        );
        if (snapshot?.id !== jobId) return;

        if (result.cancelled) {
          await markSessionCancelled(result.importId);
          cancelJobId = null;
          setSnapshot({
            id: jobId,
            kind: "connections",
            status: "cancelled",
            progress: null,
            resultMessage: `Import stopped. ${result.done} of ${total} ${label} kept.`,
          });
          return;
        }

        setSnapshot({
          id: jobId,
          kind: "connections",
          status: "completed",
          progress: null,
          resultMessage: `Imported: ${contactsCreated} created, ${contactsUpdated} updated`,
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
