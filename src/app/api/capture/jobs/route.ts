import { NextResponse, after } from "next/server";
import { captureImageFiles, normalizeCaptureInput, type CaptureMediaFile } from "@/lib/capture-ingest";
import { discardCapturePhotos, storeCapturePhotos, type StoredCapturePhoto } from "@/lib/capture-photos";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import {
  appendIngestedBlocks,
  createCaptureJob,
  failCaptureJob,
  markCaptureJobTranscribed,
  queueCaptureJobRow,
  toCaptureJobView,
  getCaptureJobRow,
} from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { sanitizeMentionPicks, type MentionPick } from "@/lib/mentions/mention-picks";
import type { CaptureJobSource } from "@/lib/capture/types";
import { friendlyError, isMissingAiApiKeyError, MISSING_AI_API_KEY_MESSAGE } from "@/lib/errors";
import { isPaywallError } from "@/lib/entitlements";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A full note's worth of OCR (`MAX_SCAN_PAGES` pages, three at a time) or a six-minute
// voice note, against whichever provider the user set — and, under `autoQueue`, the
// extraction that follows it in the same invocation.
export const maxDuration = 300;

const SOURCE_KINDS: CaptureJobSource[] = ["messy", "voice", "scan"];

/**
 * Media into a capture job: raw files in, a `transcribed` job out.
 *
 *   POST /api/capture/jobs   multipart/form-data
 *     sourceKind   messy | voice | scan
 *     text         optional — what was already typed, kept with the job
 *     files        one or more; audio, images, .ics, .eml, .txt
 *
 * NOT PDFs. Nothing here reads one — `normalizeCaptureInput` classifies by mime type and
 * `application/pdf` matches no branch, so a PDF that reaches this route is rejected by
 * name. They are rasterized to JPEG pages in the browser first, by
 * `src/lib/capture/prepare-upload.ts`, which is also where the per-request page budget is
 * spent. That is not an oversight to fix here: rasterizing client-side is what keeps ONE
 * transcription path across all three providers (see `rasterizePdf`).
 *     batchGroupId optional — one multi-file drop; suspends the one-review-at-a-time rule
 *     sourceLabel  optional — the original filename, for the queue row
 *     mentionPicks optional — JSON [{id,name}] the person picked with `@`
 *     autoQueue    optional — "1" to queue and start extraction in this same request
 *   x-orbit-capture: 1
 *
 * A route rather than a server action for the same two reasons the meeting chunk route
 * is: actions serialize per client (a transcription would block the page for its whole
 * duration), and raw multipart is a third smaller than base64 inside an action body.
 *
 * The transcription happens HERE, in this request, and the media is dropped when it ends
 * — the promise every other capture path makes. Because the row is inserted before the
 * work starts and the function runs to completion after the client disconnects, closing
 * the tab mid-transcription loses nothing: the next visit to /capture finds the job
 * `transcribed` with the text waiting. The custom header is the CSRF guard — a cross-site
 * form cannot set it, and a cross-site `fetch` that does is preflighted and refused.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.capture");
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json({ error: friendlyError(err, "Sign in to capture notes") }, { status });
  }

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Cross-origin upload refused" }, { status: 403 });
  }
  if (request.headers.get("x-orbit-capture") !== "1") {
    return NextResponse.json({ error: "Missing capture header" }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Malformed upload" }, { status: 400 });
  }
  const sourceKindRaw = String(form.get("sourceKind") ?? "messy");
  const sourceKind = (SOURCE_KINDS as string[]).includes(sourceKindRaw) ? (sourceKindRaw as CaptureJobSource) : "messy";
  const text = typeof form.get("text") === "string" ? String(form.get("text")) : "";
  const batchGroupId = typeof form.get("batchGroupId") === "string" ? String(form.get("batchGroupId")).trim().slice(0, 64) : "";
  const sourceLabel = typeof form.get("sourceLabel") === "string" ? String(form.get("sourceLabel")).trim().slice(0, 200) : "";
  const autoQueue = String(form.get("autoQueue") ?? "") === "1";
  // A date read off the filename or the file's mtime. Offered as a HINT, never as the
  // anchor itself: `runCaptureParse` only falls back to `hints.eventDate` when the notes
  // carry no date of their own, so what the model reads in the file still wins.
  const anchorRaw = typeof form.get("anchorDate") === "string" ? String(form.get("anchorDate")).trim() : "";
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw) ? anchorRaw : "";
  let mentionPicks: MentionPick[] = [];
  if (typeof form.get("mentionPicks") === "string") {
    try {
      mentionPicks = sanitizeMentionPicks(JSON.parse(String(form.get("mentionPicks"))));
    } catch {
      // A malformed picks blob loses the links, not the upload. The note itself is what
      // the person spent effort on; refusing the whole capture over a JSON slip would
      // throw that away to protect an optional convenience.
      mentionPicks = [];
    }
  }
  const uploads = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!uploads.length) {
    return NextResponse.json({ error: "Add a file first" }, { status: 400 });
  }

  const uploadBytes = uploads.reduce((sum, f) => sum + f.size, 0);
  if (uploadBytes > CAPTURE_MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `That upload is ${formatUploadSize(uploadBytes)} — the limit is ${formatUploadSize(
          CAPTURE_MAX_UPLOAD_BYTES
        )}, so try fewer or smaller files`,
      },
      { status: 413 }
    );
  }

  try {
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  const files: CaptureMediaFile[] = [];
  for (const f of uploads) {
    files.push({
      filename: f.name,
      mimeType: f.type || "application/octet-stream",
      base64: Buffer.from(await f.arrayBuffer()).toString("base64"),
    });
  }

  const job = await createCaptureJob(userId, {
    sourceKind,
    status: "ingesting",
    inputText: text,
    batchGroupId: batchGroupId || null,
    sourceLabel: sourceLabel || null,
    mentionPicks,
  });

  // Photos are kept (shrunk, stripped of metadata) so the capture history can show the page
  // next to what was pulled out of it — the same lifecycle `ingestCaptureMedia` gives them:
  // unattached now, claimed by the save, pruned if never saved. Settled, not raced, so a
  // transcription failure can still discard what was stored.
  const images = captureImageFiles(files);
  const [normalizedResult, storedResult] = await Promise.allSettled([
    normalizeCaptureInput(userId, { files }),
    storeCapturePhotos(userId, images.map((img) => ({ filename: img.filename, base64: img.base64 }))),
  ]);
  const photos: StoredCapturePhoto[] = storedResult.status === "fulfilled" ? storedResult.value : [];
  try {
    if (normalizedResult.status === "rejected") {
      await discardCapturePhotos(userId, photos.map((p) => p.id)).catch(() => {});
      throw normalizedResult.reason;
    }
    const normalized = normalizedResult.value;
    await appendIngestedBlocks(
      job.id,
      normalized.text.trim() ? [{ text: normalized.text.trim(), source: normalized.sources.join(", ") || sourceKind }] : [],
      { sources: normalized.sources, transcriptionEngine: normalized.transcriptionEngine ?? null, photoIds: photos.map((p) => p.id) }
    );
    await markCaptureJobTranscribed(job.id);

    // `autoQueue` collapses upload+Extract into one request, and it exists for arithmetic
    // rather than tidiness. Every file otherwise costs TWO `RATE_LIMITS.capture` tokens —
    // one here and one in `queueCaptureJob` — so a twelve-file drop needed 24 of the 30 a
    // minute allows, fifteen was exactly the ceiling, and the sixteenth file was refused
    // mid-drop. One token per file puts a realistic folder of meeting notes comfortably
    // inside the existing budget.
    //
    // Correct only for the fan-out path: "one file = one meeting" has no transcript-editing
    // step in between, because nobody is going to hand-edit twelve transcripts before
    // pressing Extract. The single-capture flow still queues separately, so its edit step
    // survives. `after` is valid in a Route Handler and inherits this route's maxDuration.
    if (autoQueue) {
      const hints = anchorDate && !normalized.hints.eventDate
        ? { ...normalized.hints, eventDate: anchorDate }
        : normalized.hints;
      const queued = await queueCaptureJobRow(userId, job.id, { inputText: null, inputHints: hints });
      if (queued) after(() => runCaptureJobById(job.id).catch(() => null));
    }

    const fresh = await getCaptureJobRow(userId, job.id);
    return NextResponse.json({
      ok: true,
      job: toCaptureJobView(fresh ?? job),
      text: normalized.text,
      hints: normalized.hints,
      sources: normalized.sources,
      transcriptionEngine: normalized.transcriptionEngine ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const friendly = isMissingAiApiKeyError(message)
      ? MISSING_AI_API_KEY_MESSAGE
      : friendlyError(err, "Couldn’t read that file — try again?");
    await failCaptureJob(job.id, friendly).catch(() => {});
    return NextResponse.json({ error: friendly, jobId: job.id }, { status: isMissingAiApiKeyError(message) ? 422 : 502 });
  }
}
