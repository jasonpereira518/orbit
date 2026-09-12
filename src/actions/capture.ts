"use server";

import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import type { RejectedCounts } from "@/lib/date-commitment-extract";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import type { CaptureParseHints } from "@/lib/ai";
import { runCaptureParse } from "@/lib/capture-parse";
import {
  normalizeCaptureInput,
  type CaptureMediaFile,
} from "@/lib/capture-ingest";
import {
  CAPTURE_MAX_UPLOAD_BYTES,
  formatUploadSize,
} from "@/lib/capture-limits";
import { friendlyError } from "@/lib/errors";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import {
  saveNoteBatch,
  type MeetingExtraReminderInput,
  type NoteBatchCommitmentInput,
  type NoteBatchMentionInput,
  type NoteBatchParticipantInput,
} from "@/lib/note-batch-save";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { TOAST_COPY } from "@/lib/toast-copy";
import {
  getMeetingSession,
  getNoteBatchForUser,
  markMeetingSessionSaved,
  toNoteBatchMeeting,
} from "@/lib/meeting-sessions";
import type { NoteBatchMeeting } from "@/db/schema";

export type {
  BulkNoteDuplicate,
  BulkNotePersonPreview,
  SuggestedReminderPreview,
} from "@/lib/capture/types";

/**
 * Ingest voice / photos / calendar / email into normalized capture text.
 * Media is processed ephemerally and not stored.
 */
export async function ingestCaptureMedia(input: {
  text?: string;
  files?: CaptureMediaFile[];
}) {
  try {
    const userId = await requireUserId();
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    const hasText = Boolean(input.text?.trim());
    const hasFiles = Boolean(input.files?.length);
    if (!hasText && !hasFiles) {
      return { ok: false as const, error: "Add notes or upload a file first" };
    }

    // The panel checks this before encoding, but a non-browser caller can reach the action
    // directly — and an oversized body is truncated in transit rather than refused, so the
    // only alternative to an explicit error is a mystery parse failure. Measured on the
    // decoded bytes so the number matches the file the caller actually sent.
    const uploadBytes = (input.files ?? []).reduce(
      (sum, file) => sum + Math.floor((file.base64.length * 3) / 4),
      0
    );
    if (uploadBytes > CAPTURE_MAX_UPLOAD_BYTES) {
      return {
        ok: false as const,
        error: `That upload is ${formatUploadSize(uploadBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}, so try fewer or smaller files`,
      };
    }

    const normalized = await normalizeCaptureInput(userId, {
      text: input.text,
      files: input.files,
    });

    return {
      ok: true as const,
      text: normalized.text,
      hints: normalized.hints,
      sources: normalized.sources,
      transcriptionEngine: normalized.transcriptionEngine ?? null,
    };
  } catch (err) {
    // Data, not a throw — so never stripped in production. See `friendlyError`.
    return {
      ok: false as const,
      error: friendlyError(err, TOAST_COPY.fileReadFailed),
    };
  }
}

export type BulkParseOptions = {
  /** See `CaptureParseOptions.meetingSessionId` in `src/lib/capture-parse.ts`. */
  meetingSessionId?: string | null;
};

/**
 * Parse inside a request, for callers with no durable job behind them (the chat side
 * sheet, onboarding, `log-interaction-sheet.tsx`). The /capture page runs the same
 * pipeline through `runCaptureJobById` instead, so a reload does not lose the parse.
 */
export async function parseBulkCaptureNotes(
  notes: string,
  hints?: CaptureParseHints | null,
  opts: BulkParseOptions = {}
) {
  try {
    const userId = await requireUserId();
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    if (!notes.trim()) {
      return { ok: false as const, error: "Notes are required" };
    }
    const result = await runCaptureParse(userId, notes, hints, {
      meetingSessionId: opts.meetingSessionId,
    });
    return { ok: true as const, ...result };
  } catch (err) {
    // Data, not a throw — so never stripped in production, and `toUserFacingError` put
    // raw text such as "Failed to parse AI JSON: {…" in front of the person verbatim.
    return {
      ok: false as const,
      error: friendlyError(err, TOAST_COPY.notesReadFailed),
    };
  }
}

export async function confirmBulkCapture(
  items: NoteBatchParticipantInput[],
  batch: {
    sourceHash: string;
    sourceText: string;
    anchorIso: string;
    anchorBasis: "note" | "hint" | "upload";
    entryPoint?: "capture" | "profile";
    seedContactId?: string | null;
    commitments: NoteBatchCommitmentInput[];
    mentions?: NoteBatchMentionInput[];
    skipped: RejectedCounts;
    /** A recorded meeting being saved: which one, and the digest items ticked as reminders. */
    meeting?: { sessionId: string; extraReminders: MeetingExtraReminderInput[] } | null;
  }
) {
  const userId = await requireUserId();
  await consumeBucket("capture", userId, RATE_LIMITS.capture);
  // The hash is recomputed server-side: the client echoes sourceText, and a forged hash
  // could collide with (or evade) another note's dedupe keys.
  const sourceHash = hashSourceNote(batch.sourceText);
  if (sourceHash !== batch.sourceHash) throw new Error("Note text changed since parsing; re-run extraction");

  // The digest is read from the session, never taken from the client: it is what the
  // results page will show as "what this meeting was", and it must be what the model said.
  let meetingSummary: NoteBatchMeeting | null = null;
  if (batch.meeting) {
    const session = await getMeetingSession(userId, batch.meeting.sessionId);
    if (!session) throw new Error("That meeting no longer exists");
    if (session.status === "saved" && session.noteBatchId) {
      // A double-click, or a second tab. The first save is the save.
      const existing = await getNoteBatchForUser(userId, session.noteBatchId);
      if (existing) {
        return { batchId: existing.id, created: 0, updated: 0, contactIds: [], remindersCreated: 0, result: existing.result };
      }
    }
    if (!session.digest) throw new Error("Analyze the meeting before saving it");
    meetingSummary = toNoteBatchMeeting(session);
  }

  const out = await saveNoteBatch(userId, {
    sourceText: batch.sourceText,
    sourceHash,
    anchorIso: batch.anchorIso,
    anchorBasis: batch.anchorBasis,
    entryPoint: batch.entryPoint ?? "capture",
    seedContactId: batch.seedContactId ?? null,
    participants: items,
    commitments: batch.commitments,
    mentions: batch.mentions ?? [],
    skipped: batch.skipped,
    meeting:
      batch.meeting && meetingSummary
        ? { summary: meetingSummary, extraReminders: batch.meeting.extraReminders.slice(0, 40) }
        : null,
  });

  if (batch.meeting) {
    await markMeetingSessionSaved(userId, batch.meeting.sessionId, out.batchId);
  }

  // The lib skipped embeddings and summaries (it must run outside a request scope for the
  // smoke suite); this is the request scope, so schedule them here.
  after(async () => {
    await kickEmbeddingBackfill(userId).catch(() => null);
    for (const id of out.contactIds) {
      await generateAndStoreContactBrief(userId, id).catch(() => null);
    }
  });

  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/reminders");
  revalidatePath("/graph");
  for (const id of out.contactIds) revalidatePath(`/contacts/${id}`);
  return out;
}
