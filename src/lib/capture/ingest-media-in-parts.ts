import { ingestCaptureMedia } from "@/actions/capture";
import type { CaptureMediaFile } from "@/lib/capture-ingest";
import { CAPTURE_BASE64_REQUEST_FILE_BYTES, formatUploadSize } from "@/lib/capture-limits";
import { mergeHints } from "@/lib/capture/merge-hints";
import { CAPTURE_CHUNK_SEPARATOR, base64DecodedBytes, planUploadBatches } from "@/lib/capture/upload-batches";

type IngestResult = Awaited<ReturnType<typeof ingestCaptureMedia>>;
type IngestOk = Extract<IngestResult, { ok: true }>;

/**
 * `ingestCaptureMedia`, in as many calls as the files need.
 *
 * The action's body is base64, and Vercel refuses any request over 4.5MB before the action
 * runs: a handful of scanned pages was enough to fail with nothing but a generic error. The
 * files go up in order, in batches under `CAPTURE_BASE64_REQUEST_FILE_BYTES`, and come back
 * as one result, joined the way one call joins its own files. The typed notes ride with
 * the first batch only, so they lead the text exactly as they would in a single call.
 *
 * A single file past the limit cannot be split this way and is refused by name, up front.
 */
export async function ingestCaptureMediaInParts(input: {
  text?: string;
  files: CaptureMediaFile[];
}): Promise<IngestResult> {
  const { batches, oversized } = planUploadBatches(
    input.files,
    (f) => base64DecodedBytes(f.base64),
    CAPTURE_BASE64_REQUEST_FILE_BYTES
  );
  if (oversized.length) {
    const first = oversized[0]!;
    return {
      ok: false as const,
      error: `${first.filename} is ${formatUploadSize(base64DecodedBytes(first.base64))} — one file can be at most ${formatUploadSize(CAPTURE_BASE64_REQUEST_FILE_BYTES)}`,
    };
  }
  if (batches.length <= 1) return ingestCaptureMedia(input);

  let combined: IngestOk | null = null;
  for (let i = 0; i < batches.length; i++) {
    const res = await ingestCaptureMedia({ text: i === 0 ? input.text : undefined, files: batches[i]! });
    if (!res.ok) return res;
    combined = combined
      ? {
          ...res,
          text: [combined.text, res.text].filter((t) => t.trim()).join(CAPTURE_CHUNK_SEPARATOR),
          hints: mergeHints(combined.hints, res.hints),
          sources: [...combined.sources, ...res.sources],
          transcriptionEngine: res.transcriptionEngine ?? combined.transcriptionEngine,
          photos: [...combined.photos, ...res.photos],
          photosNotKept: combined.photosNotKept + res.photosNotKept,
        }
      : res;
  }
  return combined!;
}
