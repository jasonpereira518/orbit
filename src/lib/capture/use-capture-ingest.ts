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
import { discardCaptureJob } from "@/actions/capture-jobs";
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
import type { MentionPick } from "@/lib/mentions/mention-picks";
import { aiDenialFromMessage } from "@/lib/ai-access-copy";
import { MISSING_AI_API_KEY_MESSAGE, friendlyError, isMissingAiApiKeyError } from "@/lib/errors";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";
import { releaseScanPage, type ScanPage } from "@/lib/scan-page";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import type { VoiceRecording } from "@/lib/use-voice-recorder";
import { formatElapsed } from "@/lib/voice-recording";

const CORPUS_SEPARATOR = "\n\n---\n\n";

function newJobId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null;
}

/** Extra facts about what is being uploaded, beyond the bytes. */
export type IngestExtras = {
  /** `hashFileBytes` of the ORIGINAL files, stored on the job — see `uploadCaptureMedia`. */
  fileHashes?: string[];
};

export type CaptureIngest = ReturnType<typeof useCaptureIngest>;

export function useCaptureIngest({
  sourceKind,
  hasApiKey: hasApiKeyProp,
  aiReason: aiReasonProp = null,
  initialNotes = "",
  initialMentionPicks = [],
  initialHints = null,
  initialJobId = null,
  onAutoExtract,
}: {
  sourceKind: CaptureJobSource;
  hasApiKey?: boolean;
  /** The AI gate's reason when `hasApiKey` is false — picks the notice's wording. */
  aiReason?: AiAccessDenial | null;
  initialNotes?: string;
  /** Picks restored alongside a saved draft, so its `@Name` tokens stay green. */
  initialMentionPicks?: MentionPick[];
  initialHints?: CaptureParseHints | null;
  /** A `transcribed` job the page reloaded onto; Extract queues it instead of a new row. */
  initialJobId?: string | null;
  /** Called when a transcript lands in an EMPTY box — the moment extraction may start alone. */
  onAutoExtract?: (text: string, hints: CaptureParseHints | null, jobId: string | null) => void;
}) {
  const [notes, setNotes] = useState(initialNotes);
  /**
   * Contacts named with `@` in the box.
   *
   * Here rather than in the tab component because this hook already owns the text, and the
   * two have to travel together: the picks are meaningless without the tokens they stand
   * for, and Extract sends both. A pick whose token was deleted is inert — `activePicks`
   * re-reads the text — so this list is only ever appended to.
   */
  const [mentionPicks, setMentionPicks] = useState<MentionPick[]>(initialMentionPicks);
  const [hints, setHints] = useState<CaptureParseHints | null>(initialHints);
  const [sources, setSources] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [busy, setBusy] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(hasApiKeyProp ?? true);
  const [aiReason, setAiReason] = useState<AiAccessDenial | null>(aiReasonProp);

  // A server re-render (the plan changed in another tab, or this one just bought Lifetime)
  // hands down a fresh answer; adopt it. Adjusted during render, not in an effect, so the
  // stale notice never paints for a frame.
  const [seenProps, setSeenProps] = useState({ hasApiKeyProp, aiReasonProp });
  if (seenProps.hasApiKeyProp !== hasApiKeyProp || seenProps.aiReasonProp !== aiReasonProp) {
    setSeenProps({ hasApiKeyProp, aiReasonProp });
    if (hasApiKeyProp !== undefined) setHasApiKey(hasApiKeyProp);
    setAiReason(aiReasonProp);
  }

  /** A refusal came back from the server: switch into the notice it describes. */
  const noteAiRefusal = useCallback((message: string) => {
    setHasApiKey(false);
    setAiReason(aiDenialFromMessage(message) ?? "key_required");
  }, []);

  // The box is read at the moment a transcript lands, not at the moment the upload
  // started — the person may have typed in the meantime.
  const notesRef = useRef(notes);
  const autoRef = useRef(onAutoExtract);
  useEffect(() => {
    notesRef.current = notes;
    autoRef.current = onAutoExtract;
  });

  useEffect(() => {
    // The server's answer, when given, is authoritative; only an unanswered mount asks.
    if (hasApiKeyProp !== undefined) return;
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        setHasApiKey(settings.hasApiKey);
        setAiReason(settings.ai.reason);
      })
      .catch(() => {
        // Keep extract enabled; the action returns a clear error if needed.
      });
    return () => {
      cancelled = true;
    };
  }, [hasApiKeyProp]);

  // A transcript is also a server-side capture job, and the page restores from it on reload.
  // Emptying the box (or Clear) has to discard that job too, or the text the person just
  // deleted comes straight back. Gated on `!busy`: a transcript still landing is not "empty".
  useEffect(() => {
    if (!jobId || busy || notes.trim()) return;
    let cancelled = false;
    void discardCaptureJob(jobId)
      .catch(() => {})
      .then(() => {
        if (!cancelled) setJobId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, busy, notes]);

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

  /**
   * The upload in flight, so Stop can reach it: its abort controller, the id minted for
   * its job, and the background-job row it opened. One at a time — `busy` already makes a
   * second upload wait for the first — so one ref, not a map.
   */
  const inFlightRef = useRef<{ controller: AbortController; jobId: string | null; bgId: string | null } | null>(null);

  const upload = useCallback(
    async (
      files: Parameters<typeof uploadCaptureMedia>[0]["files"],
      label: string,
      mode: "replace" | "merge",
      opts: { successMessage?: string; backgroundLabel?: string; failureFallback: string } & IngestExtras
    ) => {
      setBusy(true);
      const bgId = opts.backgroundLabel ? `capture-ingest-${Date.now()}` : null;
      if (bgId) {
        // Indeterminate on purpose: transcription is one request that fans out per page
        // on the far side, so the browser learns nothing until it is all back.
        startBackgroundJob({ id: bgId, kind: "scan-notes", label: opts.backgroundLabel!, startedAt: Date.now(), done: 0, total: 0 });
      }
      const flight = { controller: new AbortController(), jobId: newJobId(), bgId };
      inFlightRef.current = flight;
      // Whether THIS upload is still the one that owns `busy`. A Stop hands `busy` back at
      // once, and a new upload may start before this one's request has finished unwinding;
      // the old one must not then clear the new one's spinner.
      const current = () => inFlightRef.current === flight;
      try {
        const res = await uploadCaptureMedia({
          sourceKind,
          files,
          fileHashes: opts.fileHashes,
          jobId: flight.jobId,
          signal: flight.controller.signal,
        });
        // Stopped: `cancel` already discarded the job, cleared `busy` and closed the
        // background row. An abort is something the person did, not something that failed —
        // it gets no toast.
        if (flight.controller.signal.aborted || (!res.ok && res.aborted)) return;
        if (!res.ok) {
          const denial = aiDenialFromMessage(res.error);
          if (denial) noteAiRefusal(res.error);
          // The gate's own words say more than the generic key message (allowance spent,
          // payment clearing); anything else about a key reads as the plain missing-key case.
          const message =
            denial && denial !== "key_required"
              ? res.error
              : isMissingAiApiKeyError(res.error)
                ? MISSING_AI_API_KEY_MESSAGE
                : res.error;
          if (bgId) finishBackgroundJob(bgId, { status: "failed", error: message });
          toast.error(message);
          return;
        }
        if (bgId) finishBackgroundJob(bgId, { status: "completed", resultMessage: opts.successMessage });
        landTranscript(res.text, { hints: res.hints, sources: res.sources, label, jobId: res.job.id }, mode);
        if (opts.successMessage) toast.success(opts.successMessage);
      } catch (err) {
        if (flight.controller.signal.aborted) return;
        const message = friendlyError(err, opts.failureFallback);
        if (bgId) finishBackgroundJob(bgId, { status: "failed", error: message });
        toast.error(message);
      } finally {
        if (current()) {
          inFlightRef.current = null;
          setBusy(false);
        }
      }
    },
    [sourceKind, landTranscript, noteAiRefusal]
  );

  /**
   * Stop reading. Aborts the request, hands the box back straight away, and discards the
   * job the upload was creating so it cannot come back — finished and `transcribed` — on
   * the next visit.
   *
   * `stopping` because the id was minted here and the server may not have inserted the row
   * yet; the discard then leaves a tombstone that makes the late insert give up (see
   * `discardCaptureJob`). Whatever was already in the box stays: Stop cancels the upload,
   * not the note.
   */
  const cancel = useCallback(() => {
    const flight = inFlightRef.current;
    if (!flight) return;
    inFlightRef.current = null;
    flight.controller.abort();
    setBusy(false);
    if (flight.bgId) finishBackgroundJob(flight.bgId, { status: "failed", error: "Stopped" });
    if (flight.jobId) void discardCaptureJob(flight.jobId, { stopping: true }).catch(() => {});
  }, []);

  /** Text, calendar, email, audio and other raw files from a picker or a drop. */
  const handleFilesSelected = useCallback(
    (files: File[], extras: IngestExtras = {}) => {
      if (!files.length) return;
      const tooBig = oversizeMessage(files);
      if (tooBig) {
        toast.error(tooBig);
        return;
      }
      void upload(files, files.length === 1 ? files[0]!.name : `${files.length} files`, "merge", {
        successMessage: "Ready — check the text, then extract people",
        failureFallback: TOAST_COPY.fileReadFailed,
        fileHashes: extras.fileHashes,
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
    (pages: ScanPage[], extras: IngestExtras = {}) => {
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
        fileHashes: extras.fileHashes,
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
    setMentionPicks([]);
    setHints(null);
    setSources([]);
    setFileName(null);
    setJobId(null);
  }, []);

  return {
    notes,
    setNotes,
    mentionPicks,
    setMentionPicks,
    hints,
    setHints,
    sources,
    fileName,
    jobId,
    setJobId,
    busy,
    cancel,
    hasApiKey,
    setHasApiKey,
    aiReason,
    noteAiRefusal,
    scannedPhotos,
    handleFilesSelected,
    ingestScanPages,
    handleRecording,
    onPhoneTranscript,
    reset,
  };
}
