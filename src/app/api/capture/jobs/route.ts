import { NextResponse } from "next/server";
import { normalizeCaptureInput, type CaptureMediaFile } from "@/lib/capture-ingest";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import {
  appendIngestedBlocks,
  createCaptureJob,
  failCaptureJob,
  markCaptureJobTranscribed,
  toCaptureJobView,
  getCaptureJobRow,
} from "@/lib/capture-jobs";
import type { CaptureSourceKind } from "@/lib/capture/types";
import { friendlyError, isMissingAiApiKeyError, MISSING_AI_API_KEY_MESSAGE } from "@/lib/errors";
import { isPaywallError } from "@/lib/entitlements";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Eight pages of OCR or a six-minute voice note, against whichever provider the user set.
export const maxDuration = 300;

const SOURCE_KINDS: CaptureSourceKind[] = ["messy", "voice", "scan"];

/**
 * Media into a capture job: raw files in, a `transcribed` job out.
 *
 *   POST /api/capture/jobs   multipart/form-data
 *     sourceKind   messy | voice | scan
 *     text         optional — what was already typed, kept with the job
 *     files        one or more; audio, images, PDF, .ics, .eml, .txt
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
  const sourceKind = (SOURCE_KINDS as string[]).includes(sourceKindRaw) ? (sourceKindRaw as CaptureSourceKind) : "messy";
  const text = typeof form.get("text") === "string" ? String(form.get("text")) : "";
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

  const job = await createCaptureJob(userId, { sourceKind, status: "ingesting", inputText: text });

  try {
    const normalized = await normalizeCaptureInput(userId, { files });
    await appendIngestedBlocks(
      job.id,
      normalized.text.trim() ? [{ text: normalized.text.trim(), source: normalized.sources.join(", ") || sourceKind }] : [],
      { sources: normalized.sources, transcriptionEngine: normalized.transcriptionEngine ?? null }
    );
    await markCaptureJobTranscribed(job.id);
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
