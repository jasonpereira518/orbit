"use client";

/**
 * Everything that turns media into text on the capture page, in one hook.
 *
 * Picked files, scanned pages, a finished voice recording and a phone transcript all end
 * the same way: text in the box, provenance beside it, and — when the box was empty —
 * extraction starting on its own. The hook owns that contract so the Messy and Voice tabs
 * cannot drift apart, and owns the single `busy` flag so the two never disagree about
 * whether something is in flight.
 *
 * Media goes to `/api/capture/jobs`, which transcribes inside the request and leaves a
 * `transcribed` job behind, so a tab closed mid-transcription loses nothing. The job id
 * comes back here and rides along to Extract, which queues that same row.
 *
 * Copied from `bulk-notes-panel.tsx` rather than lifted out of it: the chat sheet and
 * onboarding keep the old panel, and a 1450-line refactor in the same change as a new
 * flow is how regressions hide.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings } from "@/actions/settings";
import type { CaptureParseHints } from "@/lib/ai";
import { finishBackgroundJob, startBackgroundJob } from "@/lib/background-jobs";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import {
  base64ToBlob,
  oversizeMessage,
  uploadCaptureMedia,
} from "@/lib/capture/ingest-client";
import type { CaptureJobSource } from "@/lib/capture/types";
import { MISSING_AI_API_KEY_MESSAGE, friendlyError, isMissingAiApiKeyError } from "@/lib/errors";
import { releaseScanPage, type ScanPage } from "@/lib/scan-capture";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import type { VoiceRecording } from "@/lib/use-voice-recorder";
import { formatElapsed } from "@/lib/voice-recording";

const CORPUS_SEPARATOR = "\n\n---\n\n";

export type CaptureIngest = ReturnType<typeof useCaptureIngest>;

export function useCaptureIngest({
  sourceKind,
  hasApiKey: hasApiKeyProp,
  initialNotes = "",
  initialHints = null,
  initialJobId = null,
  onAutoExtract,
}: {
  sourceKind: CaptureJobSource;
  hasApiKey?: boolean;
  initialNotes?: string;
  initialHints?: CaptureParseHints | null;
  /** A `transcribed` job the page reloaded onto; Extract queues it instead of a new row. */
  initialJobId?: string | null;
  /** Called when a transcript lands in an EMPTY box — the moment extraction may start alone. */
  onAutoExtract?: (text: string, hints: CaptureParseHints | null, jobId: string | null) => void;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [hints, setHints] = useState<CaptureParseHints | null>(initialHints);
  const [sources, setSources] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [busy, setBusy] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(hasApiKeyProp ?? true);
  const [wisprConfigured, setWisprConfigured] = useState(false);

  // The box is read at the moment a transcript lands, not at the moment the upload
  // started — the person may have typed in the meantime.
  const notesRef = useRef(notes);
  const autoRef = useRef(onAutoExtract);
  useEffect(() => {
    notesRef.current = notes;
    autoRef.current = onAutoExtract;
  });

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (hasApiKeyProp === undefined) setHasApiKey(settings.hasApiKey);
        setWisprConfigured(Boolean(settings.hasWisprKey));
      })
      .catch(() => {
        // Keep extract enabled; the action returns a clear error if needed.
      });
    return () => {
      cancelled = true;
    };
  }, [hasApiKeyProp]);

  /** Whether the text in the box came from a photograph. */
  const scannedPhotos = sources.some((s) => s.startsWith("photos"));

  const landTranscript = useCallback(
    (
      text: string,
      next: { hints: CaptureParseHints | null; sources: string[]; label: string; jobId: string | null },
      mode: "replace" | "merge"
    ) => {
      const existing = notesRef.current.trim();
      const wasEmpty = !existing;
      const merged = mode === "merge" && existing ? `${existing}${CORPUS_SEPARATOR}${text.trim()}` : text;
      setNotes(merged);
      setHints(next.hints);
      setSources(next.sources);
      setFileName(next.label);
      setJobId(next.jobId);
      if (wasEmpty && merged.trim()) autoRef.current?.(merged, next.hints, next.jobId);
      return wasEmpty;
    },
    []
  );

  const upload = useCallback(
    async (
      files: Parameters<typeof uploadCaptureMedia>[0]["files"],
      label: string,
      mode: "replace" | "merge",
      opts: { successMessage?: string; backgroundLabel?: string; failureFallback: string }
    ) => {
      setBusy(true);
      const bgId = opts.backgroundLabel ? `capture-ingest-${Date.now()}` : null;
      if (bgId) {
        // Indeterminate on purpose: transcription is one request that fans out per page
        // on the far side, so the browser learns nothing until it is all back.
        startBackgroundJob({ id: bgId, kind: "scan-notes", label: opts.backgroundLabel!, startedAt: Date.now(), done: 0, total: 0 });
      }
      try {
        const res = await uploadCaptureMedia({ sourceKind, files });
        if (!res.ok) {
          const missingKey = isMissingAiApiKeyError(res.error);
          if (missingKey) setHasApiKey(false);
          const message = missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error;
          if (bgId) finishBackgroundJob(bgId, { status: "failed", error: message });
          toast.error(message);
          return;
        }
        if (bgId) finishBackgroundJob(bgId, { status: "completed", resultMessage: opts.successMessage });
        landTranscript(res.text, { hints: res.hints, sources: res.sources, label, jobId: res.job.id }, mode);
        if (opts.successMessage) toast.success(opts.successMessage);
        // A silent downgrade is the failure mode worth naming: someone who configured
        // Wispr and got Whisper would otherwise notice only misspelled names.
        if (res.transcriptionEngine && res.transcriptionEngine !== "wispr" && wisprConfigured) {
          toast.info(
            res.transcriptionEngine === "whisper"
              ? "Transcribed with Whisper — Wispr didn’t answer"
              : "Transcribed with Gemini — Wispr didn’t answer"
          );
        }
      } catch (err) {
        const message = friendlyError(err, opts.failureFallback);
        if (bgId) finishBackgroundJob(bgId, { status: "failed", error: message });
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [sourceKind, landTranscript, wisprConfigured]
  );

  /** Text, calendar, email, audio and other raw files from a picker or a drop. */
  const handleFilesSelected = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const tooBig = oversizeMessage(files);
      if (tooBig) {
        toast.error(tooBig);
        return;
      }
      void upload(files, files.length === 1 ? files[0]!.name : `${files.length} files`, "merge", {
        successMessage: "Ready — check the text, then extract people",
        failureFallback: TOAST_COPY.fileReadFailed,
      });
    },
    [upload]
  );

  /**
   * Photographed or PDF pages, already downscaled. A scan REPLACES the box — the page is
   * the note, and merging it under stale typing produced doubled context. Uploading a
   * .txt still merges, because that is additive by nature.
   */
  const ingestScanPages = useCallback(
    (pages: ScanPage[]) => {
      if (!pages.length) return;
      const totalBytes = pages.reduce((sum, page) => sum + page.bytes, 0);
      if (totalBytes > CAPTURE_MAX_UPLOAD_BYTES) {
        toast.error(
          `Those pages total ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}, so try fewer at a time`
        );
        for (const page of pages) releaseScanPage(page);
        return;
      }
      const files = pages.map((page) => ({
        filename: page.filename,
        mimeType: page.mimeType,
        blob: base64ToBlob(page.base64, page.mimeType),
      }));
      void upload(files, pages.length === 1 ? pages[0]!.filename : `${pages.length} pages`, "replace", {
        backgroundLabel: pages.length === 1 ? "Reading your page" : `Reading ${pages.length} pages`,
        successMessage: pages.length === 1 ? "Read 1 page" : `Read ${pages.length} pages`,
        failureFallback: "Couldn’t read those pages — try again?",
      }).finally(() => {
        // The blobs only ever backed thumbnails; the bytes have been sent.
        for (const page of pages) releaseScanPage(page);
      });
    },
    [upload]
  );

  /** A finished recording, straight into the path a picked audio file takes. */
  const handleRecording = useCallback(
    (recording: VoiceRecording) => {
      if (recording.byteLength > CAPTURE_MAX_UPLOAD_BYTES) {
        toast.error(
          `That recording is ${formatUploadSize(recording.byteLength)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}`
        );
        return;
      }
      void upload(
        [{ filename: recording.filename, mimeType: recording.mimeType, blob: base64ToBlob(recording.base64, recording.mimeType) }],
        `Voice note · ${formatElapsed(recording.durationMs)}`,
        "replace",
        { failureFallback: TOAST_COPY.fileReadFailed }
      );
    },
    [upload]
  );

  /** The phone handoff: the server already transcribed; the job already holds the blocks. */
  const onPhoneTranscript = useCallback(
    (text: string, phoneSources: string[], phoneJobId: string | null = null) => {
      landTranscript(text, { hints: null, sources: phoneSources, label: "from your phone", jobId: phoneJobId }, "replace");
    },
    [landTranscript]
  );

  const reset = useCallback(() => {
    setNotes("");
    setHints(null);
    setSources([]);
    setFileName(null);
    setJobId(null);
  }, []);

  return {
    notes,
    setNotes,
    hints,
    setHints,
    sources,
    fileName,
    jobId,
    setJobId,
    busy,
    hasApiKey,
    setHasApiKey,
    scannedPhotos,
    handleFilesSelected,
    ingestScanPages,
    handleRecording,
    onPhoneTranscript,
    reset,
  };
}
