"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { addDays, format } from "date-fns";
import { toast } from "@/lib/toast";
import { useCornerClearanceAbove } from "@/lib/corner-clearance";
import {
  confirmBulkCapture,
  ingestCaptureMedia,
  parseBulkCaptureNotes,
  type BulkParseOptions,
} from "@/actions/capture";
import type { BulkNotePersonPreview, SuggestedReminderPreview } from "@/lib/capture/types";
import type { MeetingExtraReminderInput } from "@/lib/note-batch-save";
import { SuggestedRemindersReview } from "@/components/capture/suggested-reminders-review";
import {
  CAPTURE_MAX_UPLOAD_BYTES,
  formatUploadSize,
} from "@/lib/capture-limits";
import { MAX_RECORDING_MS, formatElapsed } from "@/lib/voice-recording";
import type { VoiceRecording } from "@/lib/use-voice-recorder";
import { VoiceRecorder } from "@/components/capture/voice-recorder";
import { getSettings } from "@/actions/settings";
import { BusyHint } from "@/components/imports/import-utils";
import {
  ScanControls,
  sortAndNormalizeScanFiles,
  useScanDropZone,
} from "@/components/scan/scan-controls";
import { finishBackgroundJob, startBackgroundJob } from "@/lib/background-jobs";
import { releaseScanPage, type ScanPage } from "@/lib/scan-capture";
import type { SaveNoteBatchOutput } from "@/lib/note-batch-save";
import {
  pickLockedParticipant,
  withLockedSeedPerson,
  type PreviewMention,
} from "@/lib/note-batches";
import type {
  CaptureParseHints,
  ParsedNote,
  SharedNoteContext,
} from "@/lib/ai";
import { friendlyError, isMissingAiApiKeyError, MISSING_AI_API_KEY_MESSAGE } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { TOAST_COPY } from "@/lib/toast-copy";

type Decision = "pending" | "accepted" | "discarded";

export type SuggestionReviewItem = SuggestedReminderPreview & {
  checked: boolean;
  /**
   * Overrides which person this date belongs to, by name. Names rather than ids
   * because the contacts do not exist yet at review time — the server resolves the
   * name to a contact id after the person loop creates them.
   */
  personNameOverride: string | null;
};

type ReviewItem = BulkNotePersonPreview & {
  decision: Decision;
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
  /** Locked to `lockedParticipantId` — the panel was opened from that contact's profile. */
  locked?: boolean;
};

const CAPTURE_FILE_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".ics",
  ".eml",
  "text/plain",
  "text/markdown",
  "text/calendar",
  "message/rfc822",
  "image/*",
  "application/pdf",
  ".pdf",
  "audio/*",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
].join(",");

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Filename and provenance for whatever was last ingested — "note.jpg · via photos:2". */
function IngestMeta({
  fileName,
  sources,
}: {
  fileName: string | null;
  sources: string[];
}) {
  if (!fileName && !sources.length) return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {fileName}
      {fileName && sources.length ? " · " : ""}
      {sources.length ? `via ${sources.join(", ")}` : ""}
    </span>
  );
}

export function BulkNotesPanel({
  compact = false,
  showRecorder = false,
  preferredContactId = null,
  preferredContactName = null,
  lockedParticipantId = null,
  lockedParticipantName = null,
  entryPoint,
  hasApiKey: hasApiKeyProp,
  onSaved,
  initialNotes,
  initialHints,
  autoExtract = false,
  parseOptions,
  meeting = null,
  onStartOver,
  headerSlot,
}: {
  compact?: boolean;
  /** Seed the textarea — a recorded meeting's analysis hands its notes over this way. */
  initialNotes?: string;
  initialHints?: CaptureParseHints | null;
  /** Run the extraction on mount, once, instead of waiting for the button. */
  autoExtract?: boolean;
  parseOptions?: BulkParseOptions;
  /**
   * A recorded meeting being saved. Passed through to `confirmBulkCapture`, and makes a
   * save with no people and no dates valid — the meeting's summary is worth keeping alone.
   */
  meeting?: { sessionId: string; extraReminders: MeetingExtraReminderInput[] } | null;
  /** Replaces the built-in "Start over", for a caller that owns what came before. */
  onStartOver?: () => void;
  /** Rendered above the review and done steps — the meeting flow's summary card. */
  headerSlot?: React.ReactNode;
  /**
   * Put a microphone above the textarea and let a recording drive the ingest.
   *
   * A flag rather than a separate panel: recording only changes where the text comes
   * from, and the paste/review/done machine below is identical either way. Forking it
   * would mean two copies of the parse, the review carousel and the save.
   */
  showRecorder?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  /**
   * When set, the parse is seeded with this person and whichever parsed item matches
   * them is force-merged into this contact and can't be redirected to "Create new" or
   * another merge target — used when the panel is opened from that contact's profile.
   */
  lockedParticipantId?: string | null;
  lockedParticipantName?: string | null;
  /** Where the panel was opened from. Affects the default `onSaved` behavior. */
  entryPoint?: "capture" | "profile";
  /** When known from the server, skips a settings round-trip. */
  hasApiKey?: boolean;
  /** Called after a successful save. Defaults to staying on the paste step. */
  onSaved?: (result: SaveNoteBatchOutput) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [fileName, setFileName] = useState<string | null>(null);
  const [captureHints, setCaptureHints] = useState<CaptureParseHints | null>(
    initialHints ?? null
  );
  const [ingestSources, setIngestSources] = useState<string[]>([]);
  const [step, setStep] = useState<"paste" | "review" | "done">("paste");
  // The review card's Accept row sits where the toast stack lands, and
  // `Found N people` fires in the same commit that renders the card. Lift the
  // corner above the row for as long as it is on screen — this is what keeps
  // interactive toasts from swallowing that click. See lib/corner-clearance.ts.
  const actionRowRef = useRef<HTMLDivElement | null>(null);
  useCornerClearanceAbove(actionRowRef, step === "review");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteContext[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<1 | -1>(1);
  const [suggestions, setSuggestions] = useState<SuggestionReviewItem[]>([]);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  const [anchorIso, setAnchorIso] = useState<string | null>(null);
  const [anchorBasis, setAnchorBasis] = useState<
    "note" | "hint" | "upload" | null
  >(null);
  const [skipped, setSkipped] = useState<{
    relative: number;
    unverifiable: number;
    past: number;
  } | null>(null);
  const [mentions, setMentions] = useState<PreviewMention[]>([]);
  const [hasApiKey, setHasApiKey] = useState(hasApiKeyProp ?? true);
  /** Whether to mention a fallback at all — see `ingestPayloads`. */
  const [wisprConfigured, setWisprConfigured] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        // `hasApiKeyProp` is the server's answer and stays authoritative when given; only
        // the Wispr flag needs this round-trip.
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

  useEffect(() => {
    if (hasApiKeyProp !== undefined) setHasApiKey(hasApiKeyProp);
  }, [hasApiKeyProp]);

  const accepted = items.filter((i) => i.decision === "accepted");
  const discarded = items.filter((i) => i.decision === "discarded");
  const current = items[reviewIndex] ?? null;
  const isLastCard = reviewIndex >= items.length - 1 && items.length > 0;
  const checkedDates = suggestions.filter((s) => s.checked).length;
  const saveLabel = (() => {
    const parts: string[] = [];
    if (meeting) parts.push("meeting");
    if (accepted.length) {
      parts.push(
        `${accepted.length} ${accepted.length === 1 ? "contact" : "contacts"}`
      );
    }
    const reminderCount = checkedDates + (meeting?.extraReminders.length ?? 0);
    if (reminderCount) {
      parts.push(
        `${reminderCount} ${reminderCount === 1 ? "reminder" : "reminders"}`
      );
    }
    return parts.length ? `Save ${parts.join(" + ")}` : "Save";
  })();

  function resetToPaste() {
    setStep("paste");
    setNotes("");
    setFileName(null);
    setCaptureHints(null);
    setIngestSources([]);
    setItems([]);
    setSharedNotes([]);
    setReviewIndex(0);
    setSuggestions([]);
    setSourceText(null);
    setSourceHash(null);
    setAnchorIso(null);
    setAnchorBasis(null);
    setSkipped(null);
    setMentions([]);
  }

  function decide(decision: "accepted" | "discarded") {
    if (!current) return;
    setSlideDirection(1);
    setItems((prev) =>
      prev.map((item, i) =>
        i === reviewIndex ? { ...item, decision } : item
      )
    );
    if (reviewIndex >= items.length - 1) {
      setStep("done");
    } else {
      setReviewIndex((i) => i + 1);
    }
  }

  function goBack() {
    if (reviewIndex <= 0) {
      setStep("paste");
      return;
    }
    setSlideDirection(-1);
    setReviewIndex((i) => i - 1);
    setItems((prev) =>
      prev.map((item, i) =>
        i === reviewIndex - 1 ? { ...item, decision: "pending" } : item
      )
    );
    setStep("review");
  }

  function saveAccepted() {
    start(async () => {
      try {
        const payload = accepted.map((i) => ({
          notes: i.notes,
          parsed: i.parsed,
          mergeContactId: i.mergeContactId,
          createReminder: i.createReminder,
          relationshipScore: i.relationshipScore,
          tagNames: i.tagNames
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          followUpDays: i.followUpDays,
          interactionDate: i.interactionDate,
          interactionType: i.interactionType,
        }));
        const checkedSuggestions = suggestions.filter((s) => s.checked);
        if (!payload.length && !checkedSuggestions.length && !meeting) {
          toast.error("Nothing to save — accept a person or a date first");
          return;
        }
        const res = await confirmBulkCapture(payload, {
          sourceHash: sourceHash!,
          sourceText: sourceText!,
          anchorIso: anchorIso!,
          anchorBasis: anchorBasis ?? "upload",
          entryPoint: entryPoint ?? "capture",
          seedContactId: lockedParticipantId ?? null,
          commitments: checkedSuggestions.map((s) => ({
            title: s.title,
            description: s.description,
            rawDatePhrase: s.rawDatePhrase,
            dueDateIso: s.dueDateIso,
            yearInferred: s.yearInferred,
            personName: s.personNameOverride ?? s.personName,
            actionKind: s.actionKind,
            confidenceScore: s.confidenceScore,
            sourceExcerpt: s.sourceExcerpt,
            dateBasis: s.dateBasis,
            anchorIso: s.anchorIso,
          })),
          mentions,
          skipped: skipped ?? { relative: 0, unverifiable: 0, past: 0 },
          meeting,
        });
        // The profile entry point's default path gets its own toast below (a link to
        // the fuller capture results, not a raw count) — every other path shares this
        // one summary toast, so it's hoisted here instead of repeated per branch.
        if (onSaved || entryPoint !== "profile") {
          toast.success(
            `Saved: ${res.created} created, ${res.updated} updated, ${res.remindersCreated} reminders`
          );
        }
        if (onSaved) {
          onSaved(res);
        } else if (entryPoint === "profile") {
          // Stay on the profile — nothing to navigate to here — and offer a link to
          // the fuller capture results (mentions, reminders, dedupe) instead of
          // dragging the user off the page they were already looking at.
          resetToPaste();
          router.refresh();
          toast.success("Saved — view what was created", {
            action: {
              label: "Open",
              onClick: () => router.push(`/capture/${res.batchId}`),
            },
          });
        } else {
          resetToPaste();
          router.push(`/capture/${res.batchId}`);
        }
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  /**
   * Send already-normalized scan pages for transcription.
   *
   * Deliberately does NOT pass `text`: a photographed page replaces what is in the box
   * rather than appending to it, which is what made the old dedicated scan screen feel
   * right. Uploading a .txt still merges, because that is additive by nature.
   */
  function ingestScanPages(pages: ScanPage[]) {
    if (!pages.length) return;

    const totalBytes = pages.reduce((sum, page) => sum + page.bytes, 0);
    if (totalBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      toast.error(
        `Those pages total ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}, so try fewer at a time`
      );
      return;
    }

    // Auto-extract ONLY into an empty box. A scan is a complete thought, so a second click
    // would be ceremony — but firing extraction under someone who was mid-sentence would
    // be worse, so notes already typed mean the transcript lands and waits.
    const wasEmpty = !notes.trim();

    start(async () => {
      // Inside the transition, not beside it: `Date.now()` and the job store are both
      // impure, and the React compiler rightly refuses them in a component body.
      const jobId = `scan-${Date.now()}`;
      // Indeterminate (both zero) on purpose: transcription is one server action that fans
      // out to a call per page on the far side, so the browser learns nothing until every
      // page is back. A bar here could only be animated, never measured. The page count
      // goes in the label instead, which is the part we genuinely know.
      startBackgroundJob({
        id: jobId,
        kind: "scan-notes",
        label: pages.length === 1 ? "Reading your page" : `Reading ${pages.length} pages`,
        startedAt: Date.now(),
        done: 0,
        total: 0,
      });
      try {
        const res = await ingestCaptureMedia({
          files: pages.map((page) => ({
            filename: page.filename,
            mimeType: page.mimeType,
            base64: page.base64,
          })),
        });
        if (!res.ok) {
          const missingKey = isMissingAiApiKeyError(res.error);
          if (missingKey) setHasApiKey(false);
          finishBackgroundJob(jobId, { status: "failed", error: res.error });
          toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
          return;
        }
        finishBackgroundJob(jobId, {
          status: "completed",
          resultMessage: pages.length === 1 ? "Read 1 page" : `Read ${pages.length} pages`,
        });
        setNotes(res.text);
        setCaptureHints(res.hints || null);
        setIngestSources(res.sources || []);
        setFileName(pages.length === 1 ? pages[0]!.filename : `${pages.length} pages`);
        if (wasEmpty && hasApiKey) runParse(res.text, res.hints || null);
      } catch (err) {
        const message = friendlyError(err, "Couldn’t read those pages — try again?");
        finishBackgroundJob(jobId, { status: "failed", error: message });
        toast.error(message);
      } finally {
        // The blobs only ever backed thumbnails; the base64 has already been sent.
        for (const page of pages) releaseScanPage(page);
      }
    });
  }

  function handleFilesSelected(files: File[]) {
    if (!files.length) return;

    // REJECT BEFORE ENCODING, because the failure downstream is invisible. An oversized
    // body is not refused by the server: Next buffers the first N bytes, warns in the
    // server log, and hands the action a truncated payload — which surfaces to the user
    // as a confusing parse failure long after the upload appeared to succeed. Raising the
    // limit only moves that cliff, so the size has to be checked here, where we can still
    // say something true about which files are too big.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      toast.error(
        files.length === 1
          ? `${files[0]!.name} is ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)} per upload`
          : `Those ${files.length} files total ${formatUploadSize(totalBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)} per upload, so try smaller batches`
      );
      return;
    }

    start(async () => {
      try {
        const payloads = await Promise.all(
          files.map(async (file) => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            base64: await fileToBase64(file),
          }))
        );
        await ingestPayloads(
          payloads,
          files.length === 1 ? files[0]!.name : `${files.length} files ingested`,
          "Ready — check the text, then extract people"
        );
      } catch (err) {
        toast.error(
          friendlyError(err, TOAST_COPY.fileReadFailed)
        );
      }
    });
  }

  /** A file dropped on the card takes the same path as one chosen from the picker. */
  async function acceptDroppedFiles(files: File[]) {
    if (!files.length) return;
    const { pages, raw } = await sortAndNormalizeScanFiles(files);
    if (raw.length) handleFilesSelected(raw);
    if (pages.length) ingestScanPages(pages);
  }

  const { dragging, dropProps } = useScanDropZone({
    onFiles: (files) => void acceptDroppedFiles(files),
    disabled: compact || pending,
  });

  /**
   * Whether the text in the box came from a photograph.
   *
   * Derived from the ingest sources rather than remembered in a ref, because
   * `resetToPaste` clears those — so the "Show what we read" disclosure disappears along
   * with the scan that justified it, instead of clinging to every later hand-typed note.
   */
  const scannedPhotos = ingestSources.some((s) => s.startsWith("photos"));

  /**
   * Extract people from a block of notes, as a transition. A thin wrapper over `runExtract`.
   *
   * Takes the text and hints as arguments rather than reading `notes` and `captureHints`,
   * because scanning calls this the instant a transcript lands and must not race the state
   * updates that put it there.
   */
  function runParse(text: string, hints: CaptureParseHints | null = captureHints) {
    if (!text.trim()) return;
    start(() => runExtract(text, hints));
  }

  /**
   * The shared tail of every media ingest.
   *
   * Picked files and recorded audio differ only in how the bytes were obtained; from here
   * down they are the same call, the same failure handling and the same "transcript lands
   * in the textarea, editable" contract. Kept as one function so a fix to either never has
   * to be made twice.
   */
  async function ingestPayloads(
    payloads: Array<{ filename: string; mimeType: string; base64: string }>,
    label: string,
    successMessage: string
  ) {
    const res = await ingestCaptureMedia({ text: notes, files: payloads });
    if (!res.ok) {
      const missingKey = isMissingAiApiKeyError(res.error);
      if (missingKey) setHasApiKey(false);
      toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
      return;
    }
    setNotes(res.text);
    setCaptureHints(res.hints || null);
    setIngestSources(res.sources || []);
    setFileName(label);
    toast.success(successMessage);

    // A silent downgrade is the failure mode worth naming. Someone who configured Wispr
    // and got Whisper — because the key was rejected, or the service was down — would
    // otherwise notice only that the names came back spelled wrong, with no reason given.
    // Said once, quietly, and only when a Wispr key exists to have been used.
    if (res.transcriptionEngine && res.transcriptionEngine !== "wispr" && wisprConfigured) {
      toast.info(
        res.transcriptionEngine === "whisper"
          ? "Transcribed with Whisper — Wispr didn’t answer"
          : "Transcribed with Gemini — Wispr didn’t answer"
      );
    }
  }

  /**
   * Parse the notes and move on to review. One function for the "Extract people" button and
   * for `autoExtract`, which runs it on arrival for a recorded meeting whose notes were
   * written by the analysis rather than typed.
   */
  async function runExtract(text: string, baseHints: CaptureParseHints | null) {
    try {
      const hints: CaptureParseHints | null =
        lockedParticipantId && lockedParticipantName
          ? withLockedSeedPerson(baseHints, lockedParticipantName)
          : baseHints;
      const res = await parseBulkCaptureNotes(text, hints, parseOptions ?? {});
      if (!res.ok) {
        const missingKey = isMissingAiApiKeyError(res.error);
        if (missingKey) setHasApiKey(false);
        toast.error(missingKey ? MISSING_AI_API_KEY_MESSAGE : res.error);
        return;
      }
      setSharedNotes(res.sharedNotes || []);
      const lockedKey =
        lockedParticipantId && lockedParticipantName
          ? pickLockedParticipant(
              res.items.map((item) => ({
                key: item.key,
                name: item.parsed.name,
                duplicateIds: item.duplicates.map((d) => d.id),
              })),
              { id: lockedParticipantId, name: lockedParticipantName }
            )
          : null;
      setItems(
        res.items.map((item) => {
          const isLocked = lockedKey !== null && item.key === lockedKey;
          const preferredMatch =
            preferredContactId &&
            item.duplicates.some((d) => d.id === preferredContactId)
              ? preferredContactId
              : null;
          return {
            ...item,
            decision: "pending" as const,
            mergeContactId: isLocked
              ? lockedParticipantId
              : preferredMatch || item.suggestedMergeId,
            locked: isLocked,
            createReminder: Boolean(item.parsed.follow_up_recommendation),
            relationshipScore: item.parsed.relationship_score_suggestion || 2,
            tagNames: (item.parsed.tags || []).join(", "),
            followUpDays: item.parsed.follow_up_days || 14,
          };
        })
      );
      const found = res.suggestedReminders || [];
      setSourceText(res.sourceText);
      setSourceHash(res.sourceHash);
      setAnchorIso(res.anchorIso);
      setAnchorBasis(res.anchorBasis);
      setSkipped(res.suggestionsSkipped || null);
      setMentions(res.mentions || []);
      setSuggestions(
        found.map((s) => ({
          ...s,
          // High-confidence items start checked; the user still sees
          // every one before anything is written.
          checked: s.confidenceScore >= 60,
          personNameOverride: null,
        }))
      );
      setReviewIndex(0);
      setSlideDirection(1);
      // A note can carry dates but no people — skip the person carousel.
      setStep(res.items.length ? "review" : "done");

      const peopleLabel = `${res.items.length} ${
        res.items.length === 1 ? "person" : "people"
      }`;
      const dateLabel = found.length
        ? `, ${found.length} ${found.length === 1 ? "date" : "dates"}`
        : "";
      toast.success(`Found ${peopleLabel}${dateLabel}`);
    } catch (err) {
      // Only unexpected throws reach here — a missing key comes back as
      // `res.ok === false` above — so the key message is no longer the
      // fallback. `friendlyError` still names a genuine missing key.
      const message = friendlyError(err, TOAST_COPY.notesReadFailed);
      if (message === MISSING_AI_API_KEY_MESSAGE) setHasApiKey(false);
      toast.error(message);
    }
  }

  // Once per mount, and guarded by a ref rather than state: StrictMode runs effects twice
  // in development, and a second parse would be a second paid model call.
  const autoExtractedRef = useRef(false);
  useEffect(() => {
    if (!autoExtract || autoExtractedRef.current || !initialNotes?.trim()) return;
    autoExtractedRef.current = true;
    start(() => runExtract(initialNotes, initialHints ?? null));
    // Deliberately mount-only: the props that seed an auto-extract never change for the
    // life of this panel (the meeting flow remounts it for a new analysis).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A finished recording, straight into the path a picked audio file already takes.
   *
   * The size check `handleFilesSelected` does is unnecessary here: the recorder's own
   * six-minute cap bounds the WAV at ~11 MB, which `scripts/smoke-voice-recording.ts`
   * pins below `CAPTURE_MAX_UPLOAD_BYTES`. Asserted rather than assumed, because the two
   * limits live in different files and only the test currently ties them together.
   */
  function handleRecording(recording: VoiceRecording) {
    if (recording.byteLength > CAPTURE_MAX_UPLOAD_BYTES) {
      toast.error(
        `That recording is ${formatUploadSize(recording.byteLength)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}`
      );
      return;
    }
    start(async () => {
      try {
        await ingestPayloads(
          [
            {
              filename: recording.filename,
              mimeType: recording.mimeType,
              base64: recording.base64,
            },
          ],
          `Voice note · ${formatElapsed(recording.durationMs)}`,
          "Transcribed — check the text, then extract people"
        );
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.fileReadFailed));
      }
    });
  }

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      {headerSlot}
      {step === "paste" && (
        <div
          {...(compact ? {} : dropProps)}
          className={cn(
            "space-y-3 transition-colors",
            !compact && "rounded-2xl border border-border/70 bg-card p-6 space-y-4",
            !compact && dragging && "border-dashed border-import-scan bg-import-scan/5"
          )}
        >
          {!hasApiKey && (
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
              <p className="font-medium text-foreground">
                Add an AI API key to extract people from notes
              </p>
              <p className="mt-1 text-muted-foreground">
                Orbit needs your Gemini, OpenAI, or Anthropic key — add one in{" "}
                <Link
                  href="/settings"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Settings
                </Link>
                , then come back here.
              </p>
            </div>
          )}
          {preferredContactId && preferredContactName && (
            <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Logging with{" "}
              <span className="font-medium text-foreground">
                {preferredContactName}
              </span>{" "}
              preferred for merge when they appear in the notes. You can still
              extract and review everyone else.
            </p>
          )}
          {showRecorder && (
            <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
              <VoiceRecorder
                onRecording={handleRecording}
                busy={pending}
                busyLabel="Transcribing…"
                onCapReached={() =>
                  toast.info(
                    `Stopped at ${formatElapsed(MAX_RECORDING_MS)} — your recording was kept`
                  )
                }
              />
            </div>
          )}
          <div>
            <Label htmlFor="bulk-notes">
              {showRecorder
                ? "Or type it out"
                : compact
                  ? "Paste or upload notes"
                  : "Paste, upload or photograph notes"}
            </Label>
            {!compact && (
              <p className="mt-1 text-sm text-muted-foreground">
                Drop in notes about one person or many — typed, spoken,
                photographed, or a PDF, plus calendar invites and email
                forwards. Orbit splits profiles out, keeps shared event/group
                context attached to each, and you review one card at a time.
              </p>
            )}
            {compact && (
              <p className="mt-1 text-xs text-muted-foreground">
                Multi-person notes (text / voice / photo / .ics / .eml) →
                extract → review → save.
              </p>
            )}
            <Textarea
              id="bulk-notes"
              className={cn("mt-2", compact ? "min-h-[140px]" : "min-h-[220px]")}
              placeholder={
                compact
                  ? `Met Sarah Chen at AWS Summit — Codex partnerships at OpenAI...\n\nMarcus Lee (Stripe) offered an intro...`
                  : `AWS Summit afterparty — talked with a few people over drinks about AI tooling.\n\nMet Sarah Chen — she leads Codex partnerships at OpenAI...\n\nAlso caught up with Marcus Lee (Stripe, recruiting). He offered an intro to their AI infra team...\n\nQuick note on Priya Nair from the same night — still at Notion, exploring agent workflows.`
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {compact ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={CAPTURE_FILE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  handleFilesSelected(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => fileRef.current?.click()}
              >
                Upload notes / media
              </Button>
              <IngestMeta fileName={fileName} sources={ingestSources} />
            </div>
          ) : (
            <div className="space-y-2">
              <ScanControls
                accept={CAPTURE_FILE_ACCEPT}
                disabled={pending}
                onRawFiles={handleFilesSelected}
                onPages={ingestScanPages}
                onTranscript={(text, sources) => {
                  const wasEmpty = !notes.trim();
                  // A phone transcript replaces the box, so hints from an earlier upload
                  // no longer describe what is in it.
                  setNotes(text);
                  setCaptureHints(null);
                  setIngestSources(sources);
                  setFileName("from your phone");
                  if (wasEmpty && hasApiKey) runParse(text, null);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                {pending ? <BusyHint>Reading…</BusyHint> : null}
                <IngestMeta fileName={fileName} sources={ingestSources} />
              </div>
              <p className="text-xs text-muted-foreground">
                Drop a file anywhere on this card, or paste a screenshot.
              </p>
            </div>
          )}

          <Button
            disabled={pending || !notes.trim() || !hasApiKey}
            size={compact ? "sm" : "default"}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
            onClick={() => runParse(notes)}
          >
            {pending ? "Parsing…" : "Extract people"}
          </Button>
        </div>
      )}

      {/*
        What the model read, kept one click away.

        Scanning transcribes a photograph and then throws the photograph away, so this is
        the only place an OCR mistake can still be caught — and a misread name that reaches
        a contact record is not obviously wrong once it is sitting in a form field. Closed
        by default because it is usually right; editable and re-runnable because when it is
        wrong, retyping one word beats rephotographing the page.
      */}
      {step !== "paste" && scannedPhotos && (
        <details className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground marker:hidden hover:text-ink">
            Show what we read
            {ingestSources.length > 0 && (
              <span className="ml-1 font-normal">({ingestSources.join(", ")})</span>
            )}
          </summary>
          <div className="mt-2 space-y-2">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={6}
              className="text-xs"
              aria-label="Transcribed text"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !notes.trim() || !hasApiKey}
              onClick={() => runParse(notes)}
            >
              {pending ? "Re-reading…" : "Re-run extraction"}
            </Button>
          </div>
        </details>
      )}

      {step === "review" && current && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                className={cn(
                  "font-medium text-ink",
                  compact ? "text-base" : "text-lg"
                )}
              >
                {reviewIndex + 1} of {items.length}
              </h2>
              <p className="text-xs text-muted-foreground">
                Edit if needed, then accept or discard. Shared notes stay on
                matching people.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={goBack}>
              Back
            </Button>
          </div>

          <div className="flex gap-1.5" aria-hidden>
            {items.map((item, i) => (
              <span
                key={item.key}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  i < reviewIndex && item.decision === "accepted"
                    ? "bg-primary"
                    : i < reviewIndex && item.decision === "discarded"
                      ? "bg-muted-foreground/30"
                      : i === reviewIndex
                        ? "bg-primary/60"
                        : "bg-muted"
                )}
              />
            ))}
          </div>

          {sharedNotes.length > 0 && reviewIndex === 0 && (
            <div className="space-y-2 rounded-2xl border border-sky-200/80 bg-sky-50/60 p-3 dark:border-sky-900/50 dark:bg-sky-950/20">
              <p className="text-xs font-medium text-ink">
                Shared context ({sharedNotes.length}) — applied to matching
                people
              </p>
              {sharedNotes.slice(0, 2).map((shared, idx) => (
                <p
                  key={`${idx}-${shared.text.slice(0, 24)}`}
                  className="text-xs text-muted-foreground line-clamp-2"
                >
                  {shared.text}
                </p>
              ))}
            </div>
          )}

          <div className="relative overflow-hidden">
            <AnimatePresence mode="wait" custom={slideDirection}>
              <motion.div
                key={current.key}
                custom={slideDirection}
                initial={{
                  opacity: 0,
                  x: slideDirection * 48,
                  rotate: slideDirection * 1.5,
                }}
                animate={{ opacity: 1, x: 0, rotate: 0 }}
                exit={{
                  opacity: 0,
                  x: slideDirection * -56,
                  rotate: slideDirection * -2,
                }}
                transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              >
                <PersonReviewCard
                  item={current}
                  compact={compact}
                  preferredContactId={preferredContactId}
                  preferredContactName={preferredContactName}
                  lockedParticipantName={lockedParticipantName}
                  onChange={(next) =>
                    setItems((prev) =>
                      prev.map((p, i) => (i === reviewIndex ? next : p))
                    )
                  }
                />
              </motion.div>
            </AnimatePresence>
          </div>

          <div
            ref={actionRowRef}
            className={cn(
              "grid grid-cols-2 gap-2",
              compact &&
                "sticky bottom-0 -mx-1 border-t border-border/60 bg-card pt-3"
            )}
          >
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              disabled={pending}
              onClick={() => decide("discarded")}
            >
              Discard
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={pending || !current.parsed.name?.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => decide("accepted")}
            >
              {isLastCard ? "Accept" : "Accept & next"}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div
          className={cn(
            "space-y-4",
            !compact && "rounded-2xl border border-border/70 bg-card p-6"
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2
                className={cn(
                  "font-medium text-ink",
                  compact ? "text-base" : "text-lg"
                )}
              >
                Ready to save
              </h2>
              <p className="text-xs text-muted-foreground">
                {accepted.length} accepted
                {discarded.length > 0 ? `, ${discarded.length} discarded` : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSlideDirection(-1);
                setReviewIndex(Math.max(0, items.length - 1));
                setItems((prev) =>
                  prev.map((item, i) =>
                    i === items.length - 1
                      ? { ...item, decision: "pending" }
                      : item
                  )
                );
                setStep("review");
              }}
            >
              Back
            </Button>
          </div>

          {accepted.length > 0 ? (
            <ul className="space-y-2">
              {accepted.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm"
                >
                  <span className="font-medium">
                    {item.parsed.name}
                    {item.parsed.company ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {item.parsed.company}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    {item.mergeContactId ? "Update" : "New"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : meeting ? (
            <p className="text-sm text-muted-foreground">
              No people to save from this meeting — its summary
              {suggestions.length > 0 || meeting.extraReminders.length > 0 ? " and reminders" : ""} will still be saved.
            </p>
          ) : suggestions.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              No people to save from these notes — just the dates below.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              You discarded everyone. Go back to review again, or start over.
            </p>
          )}

          {(() => {
            const itemCount = accepted.reduce((n, i) => n + i.parsed.action_items.length, 0);
            if (itemCount === 0) return null;
            const dueLabel = anchorIso
              ? format(addDays(new Date(`${anchorIso}T12:00:00`), 14), "MMM d")
              : "in 2 weeks";
            return (
              <p className="text-xs text-muted-foreground">
                {itemCount} action item{itemCount === 1 ? "" : "s"} will also become reminders due {dueLabel}
              </p>
            );
          })()}

          {mentions.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs">
              <p className="mb-1 font-medium">Mentioned, not met</p>
              <ul className="space-y-0.5">
                {mentions.map((m) => (
                  <li key={m.text}>
                    “{m.text}” {m.contactId ? <>→ linked to an existing contact ({Math.round(m.confidence * 100)}%)</> : <span className="text-muted-foreground">— no match; you can add them after saving</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <SuggestedRemindersReview
            items={suggestions}
            people={accepted.map((item) => ({
              key: item.key,
              name: item.parsed.name || "Unnamed",
            }))}
            onChange={setSuggestions}
            skipped={skipped}
          />

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              onClick={onStartOver ?? resetToPaste}
            >
              Start over
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "default"}
              disabled={pending || (!meeting && accepted.length === 0 && checkedDates === 0)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 sm:flex-1"
              onClick={saveAccepted}
            >
              {pending ? "Saving…" : saveLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonReviewCard({
  item,
  onChange,
  compact,
  preferredContactId,
  preferredContactName,
  lockedParticipantName,
}: {
  item: ReviewItem;
  onChange: (next: ReviewItem) => void;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  lockedParticipantName?: string | null;
}) {
  const updateParsed = (patch: Partial<ParsedNote>) =>
    onChange({ ...item, parsed: { ...item.parsed, ...patch } });

  const lowConfidence = new Set(item.parsed.low_confidence_fields || []);
  const [showSource, setShowSource] = useState(false);

  const showPreferred =
    preferredContactId &&
    preferredContactName &&
    !item.duplicates.some((d) => d.id === preferredContactId);

  return (
    <div
      className={cn(
        "space-y-3 rounded-2xl border border-border/70 bg-card shadow-sm",
        compact ? "p-3.5" : "p-5 space-y-4"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {item.parsed.name || "Unnamed person"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {item.sharedNoteTexts.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              Includes shared note
            </Badge>
          )}
          {item.suggestedMergeId && (
            <Badge variant="secondary" className="text-[10px]">
              Likely existing
            </Badge>
          )}
        </div>
      </div>

      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-1" : "sm:grid-cols-2 gap-3"
        )}
      >
        <Field label="Name" lowConfidence={lowConfidence.has("name")}>
          <Input
            value={item.parsed.name || ""}
            onChange={(e) => updateParsed({ name: e.target.value })}
          />
        </Field>
        <Field label="Company" lowConfidence={lowConfidence.has("company")}>
          <Input
            value={item.parsed.company || ""}
            onChange={(e) => updateParsed({ company: e.target.value })}
          />
        </Field>
        <Field label="Role" lowConfidence={lowConfidence.has("role")}>
          <Input
            value={item.parsed.role || ""}
            onChange={(e) => updateParsed({ role: e.target.value })}
          />
        </Field>
        <Field label="Met at" lowConfidence={lowConfidence.has("met_at")}>
          <Input
            value={item.parsed.met_at || ""}
            onChange={(e) => updateParsed({ met_at: e.target.value })}
          />
        </Field>
        <Field label="Tags">
          <Input
            value={item.tagNames}
            onChange={(e) => onChange({ ...item, tagNames: e.target.value })}
          />
        </Field>
      </div>

      {!compact && (
        <Field label="Summary">
          <Textarea
            value={item.parsed.summary || ""}
            onChange={(e) => updateParsed({ summary: e.target.value })}
          />
        </Field>
      )}

      {compact && item.parsed.summary && (
        <p className="text-xs text-muted-foreground sm:text-sm">
          {item.parsed.summary}
        </p>
      )}

      {item.sharedNoteTexts.length > 0 && (
        <div className="rounded-xl border border-sky-200/70 bg-sky-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-sky-900/40 dark:bg-sky-950/15">
          <p className="mb-1 font-medium text-foreground">Shared with others</p>
          {item.sharedNoteTexts.map((text) => (
            <p key={text.slice(0, 40)} className="whitespace-pre-wrap">
              {text}
            </p>
          ))}
        </div>
      )}

      {item.notes.trim() && (
        <div>
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? "Hide source text" : "Show source text"}
          </button>
          {showSource && (
            <p className="mt-1.5 whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {item.notes}
            </p>
          )}
        </div>
      )}

      {(item.parsed.topics || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.parsed.topics.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 p-2.5">
        {item.locked ? (
          <p className="text-xs text-muted-foreground">
            Logging on{" "}
            <span className="font-medium text-foreground">
              {lockedParticipantName}
            </span>
            &apos;s timeline
          </p>
        ) : (
          <>
            <p className="text-xs font-medium">Save as</p>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`merge-${item.key}`}
                checked={!item.mergeContactId}
                onChange={() => onChange({ ...item, mergeContactId: null })}
              />
              Create new contact
            </label>
            {showPreferred && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`merge-${item.key}`}
                  checked={item.mergeContactId === preferredContactId}
                  onChange={() =>
                    onChange({ ...item, mergeContactId: preferredContactId })
                  }
                />
                Merge into {preferredContactName}
              </label>
            )}
            {item.duplicates.map((d) => (
              <label key={d.id} className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  className="mt-0.5"
                  name={`merge-${item.key}`}
                  checked={item.mergeContactId === d.id}
                  onChange={() => onChange({ ...item, mergeContactId: d.id })}
                />
                <span>
                  Update{" "}
                  <Link
                    href={`/contacts/${d.id}`}
                    className="text-primary underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {d.fullName}
                  </Link>
                  {d.company ? ` (${d.company})` : ""}
                </span>
              </label>
            ))}
          </>
        )}
      </div>

      <div
        className={cn(
          "grid gap-2.5",
          compact ? "grid-cols-2" : "sm:grid-cols-3 gap-3"
        )}
      >
        <Field label="Closeness">
          <Input
            type="number"
            min={1}
            max={5}
            value={item.relationshipScore}
            onChange={(e) =>
              onChange({
                ...item,
                relationshipScore: Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Follow-up days">
          <Input
            type="number"
            min={1}
            value={item.followUpDays}
            onChange={(e) =>
              onChange({ ...item, followUpDays: Number(e.target.value) })
            }
          />
        </Field>
        <label
          className={cn(
            "flex items-center gap-2 text-xs",
            compact ? "col-span-2" : "items-end pb-2 text-sm"
          )}
        >
          <Checkbox
            checked={item.createReminder}
            onCheckedChange={(v) =>
              onChange({ ...item, createReminder: Boolean(v) })
            }
          />
          Reminder
        </label>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  lowConfidence,
}: {
  label: string;
  children: React.ReactNode;
  lowConfidence?: boolean;
}) {
  return (
    <div className={cn("space-y-1", lowConfidence && "rounded-lg")}>
      <Label
        className={cn(
          "text-xs",
          lowConfidence && "text-amber-700 dark:text-amber-400"
        )}
      >
        {label}
        {lowConfidence ? " *" : ""}
      </Label>
      <div
        className={cn(
          lowConfidence &&
            "rounded-md ring-1 ring-amber-500/50 ring-offset-1 ring-offset-background"
        )}
      >
        {children}
      </div>
    </div>
  );
}
