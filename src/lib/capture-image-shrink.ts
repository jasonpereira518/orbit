/**
 * Shrinking a photo in the browser before it is uploaded to Capture.
 *
 * Not for looks — for getting there at all. Capture media travels base64'd in a server
 * action body, and Vercel caps a function's request body at about 4.5 MB whatever
 * `serverActions.bodySizeLimit` says (see `src/lib/feedback-report.ts`). A photo straight
 * off a phone camera is 3-8 MB before base64 adds a third, so a business card scanned on a
 * phone would fail in production while working perfectly on localhost.
 *
 * Nothing the server keeps is lost: `encodeCapturePhoto` re-encodes every photo to a
 * 1600px JPEG anyway, and the transcription reads text comfortably at this size.
 */

/** Long edge after shrinking. Above the server's 1600px so its re-encode still has headroom. */
export const UPLOAD_MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

/** Below this, and already within the edge, a photo is sent as it is. */
export const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

/**
 * The size to draw at: the long edge capped at `maxEdge`, aspect ratio kept, never
 * enlarged. Pure, so the arithmetic is testable without a canvas.
 */
export function fitWithin(width: number, height: number, maxEdge = UPLOAD_MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A smaller JPEG of `file`, or `file` itself when it is not an image, is already small
 * enough, or cannot be decoded here (HEIC outside Safari, a corrupt file). Falling back to
 * the original is always safe: the server decides what it can read, and says so.
 */
export async function shrinkImageForUpload(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF rotation, so a portrait photo stays portrait once the
    // orientation tag is gone from the re-encoded bytes.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }

  try {
    const target = fitWithin(bitmap.width, bitmap.height);
    const alreadyFits = target.width === bitmap.width && target.height === bitmap.height;
    if (alreadyFits && file.size <= SHRINK_ABOVE_BYTES) return file;

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    // Keep whichever is smaller: a tiny PNG screenshot can grow as a JPEG.
    return blob && blob.size < file.size ? blob : file;
  } finally {
    bitmap.close();
  }
}
