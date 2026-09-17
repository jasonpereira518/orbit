"use client";

/**
 * Binds the pure fan-out state machine in `./fanout.ts` to component state and the upload
 * call. Everything decidable lives there; this owns only the React parts — the entry list,
 * the pump that keeps `concurrency` uploads in flight, and the timer that wakes a `waiting`
 * entry when its `Retry-After` expires.
 *
 * The pump is driven from an effect rather than a loop so a 429's wait does not block the
 * other slot: each completed upload re-renders, the effect runs again, and whatever is ready
 * starts. That also means `cancel` is just "stop starting new ones" — an upload already in
 * flight is finishing on the server whatever the tab does, which is the promise every other
 * capture path makes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { anchorForFile } from "@/lib/capture/file-date";
import {
  DEFAULT_FANOUT_CONCURRENCY,
  applyOutcome,
  markUploading,
  readyEntries,
  replaceEntry,
  summarize,
  type FanoutEntry,
  type FanoutSummary,
  type UploadOutcome,
} from "@/lib/capture/fanout";
import { oversizeMessage, uploadCaptureMedia } from "@/lib/capture/ingest-client";

export type FanoutUploader = (input: {
  file: File;
  batchGroupId: string;
  anchorIso: string | null;
}) => Promise<UploadOutcome>;

/** The real uploader. Injected so the hook can be driven by a stub in a story or a test. */
const defaultUploader: FanoutUploader = async ({ file, batchGroupId, anchorIso }) => {
  const res = await uploadCaptureMedia({
    sourceKind: "messy",
    files: [file],
    batchGroupId,
    sourceLabel: file.name,
    anchorDate: anchorIso,
    autoQueue: true,
  });
  if (res.ok) return { ok: true, jobId: res.job.id };
  return { ok: false, error: res.error, status: res.status, retryAfterSec: res.retryAfterSec };
};

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useCaptureFanout(opts?: {
  concurrency?: number;
  uploader?: FanoutUploader;
  /** Called once each file has settled, with the job ids that were created. */
  onSettled?: (jobIds: string[]) => void;
}) {
  const concurrency = opts?.concurrency ?? DEFAULT_FANOUT_CONCURRENCY;
  const uploader = opts?.uploader ?? defaultUploader;

  const [entries, setEntries] = useState<FanoutEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  // The File objects themselves never enter React state: they are large, and storing them
  // there means every re-render of the queue retains the whole drop in memory.
  const filesRef = useRef(new Map<string, File>());
  const settledRef = useRef(false);
  // Kept in a ref and synced in an effect rather than assigned during render: the callback
  // is usually an inline arrow, so depending on it directly would re-arm the settle effect
  // on every parent render.
  const onSettledRef = useRef(opts?.onSettled);
  useEffect(() => {
    onSettledRef.current = opts?.onSettled;
  }, [opts?.onSettled]);

  const add = useCallback((files: File[]) => {
    if (!files.length) return;
    // Per FILE, not per drop: each one is its own request, so the per-upload cap is what
    // applies. A single oversized file is refused by name rather than failing the batch.
    const tooBig = files.filter((f) => oversizeMessage([{ name: f.name, size: f.size }]));
    if (tooBig.length) {
      setRejected(oversizeMessage([{ name: tooBig[0].name, size: tooBig[0].size }]));
    } else {
      setRejected(null);
    }
    const usable = files.filter((f) => !tooBig.includes(f));
    if (!usable.length) return;

    const now = new Date();
    setEntries((prev) => {
      const next = [...prev];
      for (const file of usable) {
        const id = newId();
        filesRef.current.set(id, file);
        const guess = anchorForFile({ name: file.name, lastModified: file.lastModified }, now);
        next.push({
          id,
          label: file.name,
          bytes: file.size,
          status: "pending",
          jobId: null,
          anchorIso: guess.iso,
          anchorSource: guess.source,
          error: null,
          retryAt: null,
          attempts: 0,
        });
      }
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    filesRef.current.delete(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const setAnchor = useCallback((id: string, iso: string | null) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, anchorIso: iso, anchorSource: "filename" } : e))
    );
  }, []);

  const reset = useCallback(() => {
    filesRef.current.clear();
    settledRef.current = false;
    setEntries([]);
    setRunning(false);
    setRejected(null);
  }, []);

  // One batch id per run, minted when the run starts rather than per file — it is what tells
  // `queueCaptureJob` these jobs belong together and must not discard one another.
  const batchIdRef = useRef<string | null>(null);
  const start = useCallback(() => {
    if (!entries.length) return;
    batchIdRef.current = batchIdRef.current ?? newId();
    settledRef.current = false;
    setRunning(true);
  }, [entries.length]);

  const cancelPending = useCallback(() => {
    setRunning(false);
    setEntries((prev) =>
      prev.map((e) =>
        e.status === "pending" || e.status === "waiting" ? { ...e, status: "skipped" } : e
      )
    );
  }, []);

  const summary: FanoutSummary = summarize(entries);

  // The pump.
  useEffect(() => {
    if (!running) return;
    const batchGroupId = batchIdRef.current;
    if (!batchGroupId) return;

    const ready = readyEntries(entries, Date.now(), concurrency);
    if (!ready.length) return;

    let cancelled = false;
    for (const entry of ready) {
      const file = filesRef.current.get(entry.id);
      if (!file) {
        setEntries((prev) =>
          replaceEntry(prev, { ...entry, status: "failed", error: "That file is no longer available" })
        );
        continue;
      }
      setEntries((prev) => replaceEntry(prev, markUploading(entry)));
      void uploader({ file, batchGroupId, anchorIso: entry.anchorIso })
        .then((outcome) => {
          if (cancelled) return;
          setEntries((prev) => {
            const current = prev.find((e) => e.id === entry.id) ?? entry;
            return replaceEntry(prev, applyOutcome(current, outcome, Date.now()));
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : "That upload didn’t go through";
          setEntries((prev) => {
            const current = prev.find((e) => e.id === entry.id) ?? entry;
            // Network failure, not a server refusal — treated as a 0 so it is reported
            // rather than retried forever against a connection that is not coming back.
            return replaceEntry(prev, applyOutcome(current, { ok: false, error: message, status: 0, retryAfterSec: null }, Date.now()));
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [running, entries, concurrency, uploader]);

  // A `waiting` entry has no event of its own to wake it, so the pump needs a nudge when its
  // retry falls due. One timer for the soonest, re-armed as the list changes.
  useEffect(() => {
    if (!running) return;
    const soonest = entries
      .filter((e) => e.status === "waiting" && e.retryAt !== null)
      .reduce<number | null>((min, e) => (min === null || e.retryAt! < min ? e.retryAt! : min), null);
    if (soonest === null) return;
    const delay = Math.max(250, soonest - Date.now());
    const t = setTimeout(() => setEntries((prev) => [...prev]), delay);
    return () => clearTimeout(t);
  }, [running, entries]);

  // Fire `onSettled` exactly once per run.
  useEffect(() => {
    if (!running || !entries.length || !summary.done || settledRef.current) return;
    settledRef.current = true;
    setRunning(false);
    onSettledRef.current?.(entries.map((e) => e.jobId).filter((id): id is string => Boolean(id)));
  }, [running, entries, summary.done]);

  return {
    entries,
    summary,
    running,
    rejected,
    add,
    remove,
    setAnchor,
    start,
    cancelPending,
    reset,
  };
}
