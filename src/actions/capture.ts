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
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import {
  saveNoteBatch,
  type NoteBatchCommitmentInput,
  type NoteBatchMentionInput,
  type NoteBatchParticipantInput,
} from "@/lib/note-batch-save";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";

/**
 * Re-exported so existing importers keep working. The definitions moved to
 * `@/lib/capture-preview`, which has no runtime imports — `bulk-notes-panel.tsx` is a
 * client component, and anything it pulls in that reaches `@/db` fails the build with a
 * `node:fs` chunking error naming neither file.
 */
export type {
  BulkNoteDuplicate,
  BulkNotePersonPreview,
  SuggestedReminderPreview,
} from "@/lib/capture-preview";

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
        error: `That upload is ${formatUploadSize(uploadBytes)} — the limit is ${formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES)}. Try fewer or smaller files.`,
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
    };
  } catch (err) {
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
    };
  }
}

/**
 * Parse notes into review items, in one shot.
 *
 * The pipeline itself lives in `runCaptureParse` so `/api/capture/parse` can stream the
 * same work. This wrapper stays because `log-interaction-sheet.tsx` has no review step and
 * nothing to stream to — the same reason `askNetwork` survived alongside `/api/chat`.
 */
export async function parseBulkCaptureNotes(
  notes: string,
  hints?: CaptureParseHints | null
) {
  try {
    const userId = await requireUserId();
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
    if (!notes.trim()) {
      return { ok: false as const, error: "Notes are required" };
    }
    const result = await runCaptureParse(userId, notes, hints);
    return result.ok ? { ...result, ok: true as const } : { ok: false as const, error: result.error };
  } catch (err) {
    return {
      ok: false as const,
      error: toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message,
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
  }
) {
  const userId = await requireUserId();
  await consumeBucket("capture", userId, RATE_LIMITS.capture);
  // The hash is recomputed server-side: the client echoes sourceText, and a forged hash
  // could collide with (or evade) another note's dedupe keys.
  const sourceHash = hashSourceNote(batch.sourceText);
  if (sourceHash !== batch.sourceHash) throw new Error("Note text changed since parsing; re-run extraction");

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
  });

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
