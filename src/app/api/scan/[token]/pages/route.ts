import { NextResponse, type NextRequest } from "next/server";
import { normalizeCaptureInput, type CaptureMediaFile } from "@/lib/capture-ingest";
import { CAPTURE_MAX_UPLOAD_BYTES, formatUploadSize } from "@/lib/capture-limits";
import { toUserFacingError } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { MAX_SCAN_PAGES, estimateDecodedBytes } from "@/lib/scan-image";
import {
  findScanHandoff,
  markHandoffUploading,
  recordHandoffError,
  recordHandoffTranscript,
} from "@/lib/scan-handoff";

/**
 * Pages photographed on a phone, posted against a scan handoff token.
 *
 * The phone carries no Clerk session — that is the entire point of the handoff — so this
 * route is exempted in `PUBLIC_ROUTES` and authenticated solely by the opaque token in its
 * path, the same arrangement as the calendar feed. Transcription runs here, as the minting
 * user, so their configured provider and their key are what read the photos.
 *
 * The images are transcribed and dropped. Nothing about them is written down.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// OCR of eight pages, three at a time, against whichever provider the user configured.
export const maxDuration = 300;

/** 404 for every refusal. A 401 would confirm the route gates by token. */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Shape-checked inside, before any query, so malformed traffic costs no database work.
  const handoff = await findScanHandoff(token);
  if (!handoff) return notFound();

  let files: CaptureMediaFile[];
  try {
    const body = (await request.json()) as { files?: CaptureMediaFile[] };
    files = Array.isArray(body?.files) ? body.files : [];
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  if (!files.length) {
    return NextResponse.json({ error: "Add at least one photo first" }, { status: 400 });
  }
  if (files.length > MAX_SCAN_PAGES) {
    return NextResponse.json(
      { error: `That is more than ${MAX_SCAN_PAGES} pages. Send them in two goes.` },
      { status: 400 }
    );
  }

  // Measured on decoded bytes so the number matches the photos the phone actually took.
  const uploadBytes = files.reduce(
    (sum, file) => sum + estimateDecodedBytes(file.base64.length),
    0
  );
  if (uploadBytes > CAPTURE_MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `That upload is ${formatUploadSize(uploadBytes)} — the limit is ${formatUploadSize(
          CAPTURE_MAX_UPLOAD_BYTES
        )}.`,
      },
      { status: 413 }
    );
  }

  try {
    // Keyed on the owner, not the token: the budget being protected is the account's AI
    // spend, and a leaked token must not get a fresh allowance by being re-minted.
    await consumeBucket("captureHandoff", handoff.userId, RATE_LIMITS.captureHandoff);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  await markHandoffUploading(handoff.id);

  try {
    const normalized = await normalizeCaptureInput(handoff.userId, { files });
    await recordHandoffTranscript(handoff.id, {
      transcript: normalized.text,
      pageCount: files.length,
      sources: normalized.sources.join(", "),
    });
    return NextResponse.json({ ok: true, pageCount: files.length });
  } catch (err) {
    // Recorded rather than only returned, so the desktop stops waiting and says why. The
    // grant stays redeemable: the usual cause is one bad photo, and walking back to the
    // laptop for a fresh QR code just to retake it would be a poor trade.
    const message = toUserFacingError(err).message;
    await recordHandoffError(handoff.id, message).catch(() => {});
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
