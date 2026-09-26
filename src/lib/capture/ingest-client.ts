/**
 * The browser side of capture ingest: what the pickers accept, how a file becomes bytes
 * the server can read, and the one upload call. No server imports — this is pulled into
 * client components, and anything reaching `@/db` would drag `node:fs` into the bundle.
 */
import { CAPTURE_MAX_UPLOAD_BYTES, CAPTURE_REQUEST_FILE_BYTES, formatUploadSize } from "@/lib/capture-limits";
import { mergeHints } from "@/lib/capture/merge-hints";
import { CAPTURE_CHUNK_SEPARATOR, planUploadBatches } from "@/lib/capture/upload-batches";
import type { CaptureParseHints } from "@/lib/ai";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { CaptureJobSource } from "@/lib/capture/types";

export const CAPTURE_FILE_ACCEPT = [
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

export const AUDIO_FILE_ACCEPT = ["audio/*", ".webm", ".mp3", ".wav", ".m4a", ".ogg"].join(",");

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * The size refusal, worded before anything is encoded. Null when the files fit.
 *
 * Checked in the browser because the failure downstream is invisible: an oversized body
 * is not refused by the server, it is truncated — HTTP 200, garbage later.
 */
export function oversizeMessage(files: { name: string; size: number }[]): string | null {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= CAPTURE_MAX_UPLOAD_BYTES) return null;
  const limit = formatUploadSize(CAPTURE_MAX_UPLOAD_BYTES);
  return files.length === 1
    ? `${files[0]!.name} is ${formatUploadSize(totalBytes)} — the limit is ${limit} per upload`
    : `Those ${files.length} files total ${formatUploadSize(totalBytes)} — the limit is ${limit} per upload, so try smaller batches`;
}

export type CaptureUploadResult =
  | {
      ok: true;
      job: CaptureJobView;
      text: string;
      hints: CaptureParseHints;
      sources: string[];
      transcriptionEngine: string | null;
    }
  | { ok: false; error: string; status: number; retryAfterSec: number | null };

type UploadFile = File | { filename: string; mimeType: string; blob: Blob };

type UploadInput = {
  sourceKind: CaptureJobSource;
  text?: string;
  files: UploadFile[];
  /** Set when this file is one of a multi-file drop. Suspends the one-review-at-a-time rule. */
  batchGroupId?: string | null;
  /** The original filename, for the queue row. */
  sourceLabel?: string | null;
  /** YYYY-MM-DD read off the filename or mtime, offered to the parse as `hints.eventDate`. */
  anchorDate?: string | null;
  /** Contacts named with `@` in the composer. */
  mentionPicks?: Array<{ id: string; name: string }>;
  /**
   * Queue and start extraction inside this same request.
   *
   * For the fan-out path only, and the reason is arithmetic: every file otherwise costs two
   * `RATE_LIMITS.capture` tokens, one here and one in `queueCaptureJob`, so twelve files
   * needed 24 of the 30 a minute allows. The single-capture flow keeps them separate because
   * it has a transcript-editing step in between; a folder of meeting notes does not.
   */
  autoQueue?: boolean;
};

const asFile = (f: UploadFile): File =>
  f instanceof File ? f : new File([f.blob], f.filename, { type: f.mimeType });

/**
 * Send media to `/api/capture/jobs`, which transcribes it inside the request and leaves a
 * `transcribed` job behind. A dropped connection after the bytes land loses nothing.
 *
 * In parts when it has to be. Vercel refuses a request body over 4.5MB before the route
 * runs, and one capture can be several times that (twelve scanned pages budget 14.4MB).
 * The files are split, in order, into requests under `CAPTURE_REQUEST_FILE_BYTES`: the
 * first creates the job, each later one extends it, and only the last moves it to
 * `transcribed` (and queues it, under `autoQueue`). The caller sees one result either way:
 * the parts' text joined the way the server joins one request's files, and their hints
 * merged the way the server merges them.
 */
export async function uploadCaptureMedia(input: UploadInput): Promise<CaptureUploadResult> {
  const files = input.files.map(asFile);
  const { batches, oversized } = planUploadBatches(files, (f) => f.size, CAPTURE_REQUEST_FILE_BYTES);
  if (oversized.length) {
    const first = oversized[0]!;
    return {
      ok: false,
      status: 413,
      retryAfterSec: null,
      error: `${first.name} is ${formatUploadSize(first.size)} — one file can be at most ${formatUploadSize(CAPTURE_REQUEST_FILE_BYTES)}`,
    };
  }
  if (batches.length <= 1) return postCapturePart(input, files, { final: true });

  const isPage = (f: File) => f.type.startsWith("image/");
  const pageTotal = files.filter(isPage).length;
  let pageOffset = 0;
  let jobId: string | null = null;
  let last: Extract<CaptureUploadResult, { ok: true }> | null = null;
  const texts: string[] = [];
  const sources: string[] = [];
  let hints: CaptureParseHints = {};
  let transcriptionEngine: string | null = null;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const res = await postCapturePart(input, batch, {
      final: i === batches.length - 1,
      continueJobId: jobId,
      pageOffset,
      pageTotal,
    });
    if (!res.ok) return res;
    jobId = res.job.id;
    pageOffset += batch.filter(isPage).length;
    if (res.text.trim()) texts.push(res.text.trim());
    sources.push(...res.sources);
    hints = mergeHints(hints, res.hints);
    transcriptionEngine = res.transcriptionEngine ?? transcriptionEngine;
    last = res;
  }

  return {
    ok: true,
    job: last!.job,
    text: texts.join(CAPTURE_CHUNK_SEPARATOR),
    hints,
    sources,
    transcriptionEngine,
  };
}

/** One request: the whole capture, or one part of it. */
async function postCapturePart(
  input: UploadInput,
  files: File[],
  part: { final: boolean; continueJobId?: string | null; pageOffset?: number; pageTotal?: number }
): Promise<CaptureUploadResult> {
  const form = new FormData();
  form.set("sourceKind", input.sourceKind);
  if (part.continueJobId) {
    // The job already carries the note's text, label, date and picks from the first part.
    form.set("continueJobId", part.continueJobId);
  } else {
    if (input.text) form.set("text", input.text);
    if (input.batchGroupId) form.set("batchGroupId", input.batchGroupId);
    if (input.sourceLabel) form.set("sourceLabel", input.sourceLabel);
    if (input.mentionPicks?.length) form.set("mentionPicks", JSON.stringify(input.mentionPicks));
  }
  if (input.anchorDate) form.set("anchorDate", input.anchorDate);
  if (input.autoQueue) form.set("autoQueue", "1");
  if (!part.final) form.set("final", "0");
  if (part.pageTotal) {
    form.set("pageOffset", String(part.pageOffset ?? 0));
    form.set("pageTotal", String(part.pageTotal));
  }
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/capture/jobs", {
    method: "POST",
    body: form,
    headers: { "x-orbit-capture": "1" },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Carried out so the queue can wait rather than drop the file. A 429 in the middle of a
    // twelve-file drop must never mean "that one silently did not upload".
    const header = res.headers.get("Retry-After");
    const retryAfterSec = header && /^\d+$/.test(header) ? Number(header) : null;
    return {
      ok: false,
      status: res.status,
      retryAfterSec,
      error:
        typeof body.error === "string"
          ? body.error
          : // Vercel's own refusal is plain text, so there is no `error` to show. Say what it
            // means rather than "try again", which would fail the same way forever.
            res.status === 413
            ? `That upload is too large to send — try fewer or smaller files`
            : "Couldn’t read that file — try again?",
    };
  }
  return {
    ok: true,
    job: body.job as CaptureJobView,
    text: String(body.text ?? ""),
    hints: (body.hints as CaptureParseHints) ?? {},
    sources: Array.isArray(body.sources) ? (body.sources as string[]) : [],
    transcriptionEngine: typeof body.transcriptionEngine === "string" ? body.transcriptionEngine : null,
  };
}

/** Base64 → Blob, for a recording the recorder hands over already encoded. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
