"use client";

/**
 * Binds the pure fan-out state machine in `./fanout.ts` to component state and the upload
 * call. Everything decidable lives there; this owns only the React parts — the entry list,
 * the pump that keeps `concurrency` uploads in flight, and the timer that wakes a `waiting`
 * entry when its `Retry-After` expires.
 *
 * It does NOT own staging. What was dropped, how it is grouped and what each group is called
 * all belong to the sorting dialog (`src/lib/capture/bins.ts`); this is handed the finished
 * plan and uploads it. That split is why the dialog can be re-opened and re-sorted without
 * anything here knowing, and why this file holds no `File` in state.
 *
 * The pump is driven from an effect rather than a loop so a 429's wait does not block the
 * other slot: each completed upload re-renders, the effect runs again, and whatever is ready
 * starts. That also means `cancelPending` is first "stop starting new ones" — an upload
 * already in flight is finishing on the server whatever the tab does. It is not ONLY that:
 * each such upload is also discarded the moment its job id lands, because under `autoQueue`
 * the request that is still running will queue that job and start reading it, and a note
 * the person cancelled must not turn up for review anyway. The request is left to finish
 * rather than aborted on purpose — aborting would lose the id, and the id is the only
 * handle there is on the job it creates.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_FANOUT_CONCURRENCY,
  applyOutcome,
  markUploading,
  replaceEntry,
  startableEntries,
  summarize,
  type FanoutEntry,
  type FanoutSummary,
  type UploadOutcome,
} from "@/lib/capture/fanout";
import { discardCaptureJob } from "@/actions/capture-jobs";
import { uploadCaptureMedia } from "@/lib/capture/ingest-client";
import { prepareNotice, prepareUploadFiles } from "@/lib/capture/prepare-upload";
import type { PlannedUpload } from "@/lib/capture/bins";

export type FanoutUploader = (input: {
  files: File[];
  label: string;
  batchGroupId: string;
  anchorIso: string | null;
  /** `PlannedUpload.fileHashes` — the originals' hashes, stored on the job. */
  fileHashes?: string[];
}) => Promise<UploadOutcome>;

/** Throws a cancelled note's job away. Injected alongside the uploader, for the same reason. */
export type FanoutDiscarder = (jobId: string) => Promise<unknown>;

const defaultDiscarder: FanoutDiscarder = (jobId) => discardCaptureJob(jobId).catch(() => null);

/**
 * The real uploader. Injected so the hook can be driven by a stub in a story or a test.
 *
 * PREPARATION HAPPENS HERE, per note, immediately before that note's request — not once for
 * the whole drop in the sorting dialog. Two reasons, and the second is the one that fixes a
 * bug:
 *
 *   1. It is paced. Rasterizing a PDF is the most expensive thing this feature does, and
 *      doing it inside the pump means at most `concurrency` of them run at once, on notes
 *      the person actually pressed Read on rather than on everything they dropped.
 *   2. The page budget is per REQUEST, so preparing per request is what gives each note its
 *      own `MAX_SCAN_PAGES`. Prepared together, a drop of three PDFs read the first few
 *      pages of the first one and none of the other two.
 *
 * A note whose files ALL fail to prepare is a failed note, not an empty upload: sending a
 * request with no files would leave a capture job with nothing in it, which reads on the
 * timeline as a meeting about nothing.
 */
const defaultUploader: FanoutUploader = async ({ files, label, batchGroupId, anchorIso, fileHashes }) => {
  const prepared = await prepareUploadFiles(files);
  if (!prepared.files.length) {
    const why = prepared.failures[0]?.message ?? "Nothing in this note could be read";
    return { ok: false, error: why, status: 0, retryAfterSec: null };
  }
  const res = await uploadCaptureMedia({
    sourceKind: "messy",
    files: prepared.files,
    batchGroupId,
    sourceLabel: label,
    anchorDate: anchorIso,
    autoQueue: true,
    fileHashes,
  });
  if (res.ok) return { ok: true, jobId: res.job.id, notice: prepareNotice(prepared) };
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
  discarder?: FanoutDiscarder;
  /** Called once every bin has settled, with the job ids that were created. */
  onSettled?: (jobIds: string[]) => void;
}) {
  const concurrency = opts?.concurrency ?? DEFAULT_FANOUT_CONCURRENCY;
  const uploader = opts?.uploader ?? defaultUploader;
  const discarder = opts?.discarder ?? defaultDiscarder;

  const [entries, setEntries] = useState<FanoutEntry[]>([]);
  const [running, setRunning] = useState(false);

  // The File objects never enter React state: they are large, and storing them there means
  // every re-render of the queue retains the whole drop in memory.
  const filesRef = useRef(new Map<string, File[]>());
  /** Per entry, the originals' hashes — beside the files, and kept out of state for the same reason. */
  const hashesRef = useRef(new Map<string, string[]>());
  /**
   * Entry ids whose upload was in flight when the run was cancelled. Their jobs are
   * discarded as the ids land — see the header. A ref, not state: it is read in the upload's
   * own completion, which must see the cancel however many renders ago it happened.
   */
  const cancelledRef = useRef(new Set<string>());
  /**
   * Set by Stop, cleared by the next `start`. The pump checks THIS rather than trusting its own
   * `running`: React runs the pump effect after the commit it belongs to, sometimes a tick
   * later, so a pump from the render before Stop can still run after Stop with `running` true
   * in its closure. It used to start the first uploads right over the rows Stop had skipped,
   * and they landed `queued` — a note the person cancelled, read anyway.
   */
  const stoppedRef = useRef(false);
  const settledRef = useRef(false);
  // Kept in a ref and synced in an effect rather than assigned during render: the callback
  // is usually an inline arrow, so depending on it directly would re-arm the settle effect
  // on every parent render.
  const onSettledRef = useRef(opts?.onSettled);
  useEffect(() => {
    onSettledRef.current = opts?.onSettled;
  }, [opts?.onSettled]);

  /** One batch id per run, minted when the run starts rather than per bin — it is what tells
   *  `queueCaptureJob` these jobs belong together and must not discard one another. */
  const batchIdRef = useRef<string | null>(null);

  /**
   * Take a sorted plan and begin.
   *
   * `resolve` turns a staged file id back into the `File`, because the plan carries ids and
   * the dialog holds the bytes. A plan referring to a file that is no longer available fails
   * that one entry rather than the run.
   */
  const start = useCallback(
    (plans: readonly PlannedUpload[], resolve: (fileId: string) => File | undefined) => {
      if (!plans.length) return;
      const next: FanoutEntry[] = [];
      const files = new Map<string, File[]>();
      const hashes = new Map<string, string[]>();
      for (const plan of plans) {
        const id = newId();
        const resolved = plan.fileIds.map(resolve).filter((f): f is File => Boolean(f));
        files.set(id, resolved);
        hashes.set(id, plan.fileHashes ?? []);
        next.push({
          id,
          label: plan.label,
          bytes: plan.bytes,
          fileCount: resolved.length,
          status: resolved.length ? "pending" : "failed",
          jobId: null,
          anchorIso: plan.anchorIso,
          error: resolved.length ? null : "Those files are no longer available",
          notice: null,
          retryAt: null,
          attempts: 0,
        });
      }
      filesRef.current = files;
      hashesRef.current = hashes;
      cancelledRef.current = new Set();
      stoppedRef.current = false;
      batchIdRef.current = newId();
      settledRef.current = false;
      setEntries(next);
      setRunning(true);
    },
    []
  );

  const reset = useCallback(() => {
    filesRef.current.clear();
    hashesRef.current.clear();
    settledRef.current = false;
    batchIdRef.current = null;
    setEntries([]);
    setRunning(false);
  }, []);

  /** Ids started and not yet settled — see `startableEntries` for why the list alone won't do. */
  const inFlightRef = useRef(new Set<string>());

  const cancelPending = useCallback(() => {
    stoppedRef.current = true;
    setRunning(false);
    // In flight right now: let each request finish, then discard what it made (see the
    // header). Read from the ref, not `entries` — an upload the pump started this very
    // render may not show as `uploading` in the list yet.
    for (const id of inFlightRef.current) cancelledRef.current.add(id);
    setEntries((prev) =>
      prev.map((e) =>
        e.status === "pending" || e.status === "waiting" || cancelledRef.current.has(e.id)
          ? { ...e, status: "skipped" }
          : e
      )
    );
  }, []);

  const summary: FanoutSummary = summarize(entries);

  // Outcomes are applied unless the component has gone. NOT a per-run `cancelled` flag: the
  // pump's own `setEntries(markUploading…)` re-runs this effect, so its cleanup fires straight
  // after every start, and a flag set there discarded every outcome — each note sat at
  // "uploading" and the run never finished. An upload outlives the run that started it.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The pump.
  useEffect(() => {
    if (!running || stoppedRef.current) return;
    const batchGroupId = batchIdRef.current;
    if (!batchGroupId) return;

    const ready = startableEntries(entries, inFlightRef.current, Date.now(), concurrency);
    for (const entry of ready) {
      const files = filesRef.current.get(entry.id);
      if (!files?.length) {
        setEntries((prev) =>
          replaceEntry(prev, { ...entry, status: "failed", error: "Those files are no longer available" })
        );
        continue;
      }
      inFlightRef.current.add(entry.id);
      setEntries((prev) => replaceEntry(prev, markUploading(entry)));
      const settle = (outcome: UploadOutcome) => {
        inFlightRef.current.delete(entry.id);
        if (cancelledRef.current.has(entry.id)) {
          // Cancelled while it was uploading. The job exists now, and under `autoQueue` it
          // is already queued to be read — so it goes, whether or not anyone is still
          // mounted to see it go. The row stays `skipped`, which is what the person chose.
          if (outcome.ok) void discarder(outcome.jobId);
          return;
        }
        if (!mountedRef.current) return;
        setEntries((prev) => {
          const current = prev.find((e) => e.id === entry.id) ?? entry;
          return replaceEntry(prev, applyOutcome(current, outcome, Date.now()));
        });
      };
      void uploader({
        files,
        label: entry.label,
        batchGroupId,
        anchorIso: entry.anchorIso,
        fileHashes: hashesRef.current.get(entry.id),
      })
        // Two-argument `then`, so a throw inside `settle` is not mistaken for a failed upload.
        .then(settle, (err: unknown) => {
          const message = err instanceof Error ? err.message : "That upload didn’t go through";
          // Network failure, not a server refusal — treated as a 0 so it is reported
          // rather than retried forever against a connection that is not coming back.
          settle({ ok: false, error: message, status: 0, retryAfterSec: null });
        });
    }
  }, [running, entries, concurrency, uploader, discarder]);

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

  return { entries, summary, running, start, cancelPending, reset };
}
