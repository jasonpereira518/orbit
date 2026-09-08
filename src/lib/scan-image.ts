/**
 * The pure half of note scanning: how far a page should be shrunk, what a picked file
 * actually is, and how many pages we are willing to read at once.
 *
 * DOM-free on purpose, so `scripts/smoke-scan-image.ts` can exercise the arithmetic under
 * plain node — the same split `dictation.ts` uses for voice. The live canvas, camera and
 * PDF rasterizing live in `use-scan-capture.ts`, which is browser-only and lazily
 * imported so neither it nor `pdfjs-dist` rides the app shell bundle.
 *
 * WHY EVERY PAGE COMES OUT AS A JPEG. Re-encoding is not only about size. `capture-ingest`
 * accepts `.heic`/`.heif`, and an iPhone's camera roll is the single likeliest source for
 * this feature — but of the three providers only Gemini reads HEIC. OpenAI and Anthropic
 * do not, and `completeMultimodalJsonInner` used to paper over that by relabelling the
 * bytes `image/jpeg` on the way out, which turns "unsupported format" into a mystery
 * decode error. Decoding to a canvas and re-encoding makes the format claim true, and
 * takes an 8MP photo from ~8MB to a few hundred KB on the same pass.
 */

/**
 * Longest edge of a page we send, and the ladder we walk down to fit the byte target.
 *
 * Starts far higher than the screenshot ladder's 1280 because this is the opposite
 * problem: a screenshot is already crisp text rendered at native resolution, while this is
 * a photograph of small, low-contrast handwriting. 2000px is about the point where a
 * ballpoint note filling an A4 page stays legible to a vision model.
 */
export const SCAN_EDGE_LADDER = [2000, 1600, 1200] as const;

/** Tried in order at each edge before stepping the edge down. */
export const SCAN_QUALITY_LADDER = [0.82, 0.72, 0.62] as const;

/**
 * Byte target per page, after encoding.
 *
 * Not a hard cap on what the server accepts — that is `CAPTURE_MAX_UPLOAD_BYTES` — but the
 * size we aim each page at so that a full 8-page scan lands around 10MB and never has to
 * discover the request limit the hard way.
 */
export const SCAN_TARGET_BYTES = 1_200_000;

/** Everything is re-encoded to this. See the file header. */
export const SCAN_OUTPUT_MIME = "image/jpeg";

/**
 * Pages per scan. The single source of truth: `capture-ingest` imports this rather than
 * keeping its own copy, so the client's page counter and the server's slice cannot drift.
 */
export const MAX_SCAN_PAGES = 8;

export type ScanFailure =
  | "unsupported-type"
  | "heic-undecodable"
  | "decode-failed"
  | "encode-failed"
  | "empty-pdf"
  | "no-camera"
  | "camera-denied"
  | "insecure-context"
  | "unknown";

export class ScanError extends Error {
  readonly reason: ScanFailure;
  constructor(reason: ScanFailure, message?: string) {
    super(message ?? reason);
    this.name = "ScanError";
    this.reason = reason;
  }
}

/** What kind of thing the person picked. */
export type ScanFileKind = "image" | "pdf" | "unsupported";

const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff",
];

function extensionOf(filename: string) {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/**
 * Classify by mime OR extension, because neither alone is reliable: a phone camera roll
 * often hands over `image/heic` with a `.HEIC` name, while some Android pickers supply an
 * empty mime type and nothing but the name.
 */
export function classifyScanFile(filename: string, mimeType: string): ScanFileKind {
  const ext = extensionOf(filename);
  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "unsupported";
}

/**
 * HEIC needs its own answer because the failure is browser-specific, not file-specific:
 * Safari decodes it natively, Chrome and Firefox cannot decode it at all. Worth detecting
 * up front so the desktop path can say so plainly instead of failing at `createImageBitmap`.
 */
export function isHeicSource(filename: string, mimeType: string): boolean {
  const ext = extensionOf(filename);
  const mime = mimeType.toLowerCase();
  return mime === "image/heic" || mime === "image/heif" || ext === "heic" || ext === "heif";
}

export type Dimensions = { width: number; height: number };

/**
 * Scale `width`×`height` so its longest edge is at most `edge`, never scaling up.
 * Always at least 1×1 — a zero-dimension canvas throws in every engine.
 */
export function fitEdge(width: number, height: number, edge: number): Dimensions {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, edge / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type EncodeAttempt = { edge: number; quality: number };

/**
 * Every (edge, quality) pair to try, in order: drop quality first, then resolution.
 *
 * Quality first because handwriting survives JPEG artefacts far better than it survives
 * being made smaller — a stroke that has been resampled away is gone, while one that is
 * merely blocky is still readable.
 */
export function scanEncodeAttempts(): EncodeAttempt[] {
  const attempts: EncodeAttempt[] = [];
  for (const edge of SCAN_EDGE_LADDER) {
    for (const quality of SCAN_QUALITY_LADDER) attempts.push({ edge, quality });
  }
  return attempts;
}

/** Base64 costs 4 bytes per 3, rounded up to a 4-char group. Mirrors `capture-ingest`. */
export function estimateBase64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/** The inverse, matching the estimate `capture-ingest` and `capture.ts` both use. */
export function estimateDecodedBytes(base64Length: number): number {
  return Math.floor((base64Length * 3) / 4);
}

export type PageCap = { kept: number; dropped: number };

/** How many of `count` pages we will actually read, and how many fall off the end. */
export function capScanPages(count: number): PageCap {
  const kept = Math.max(0, Math.min(count, MAX_SCAN_PAGES));
  return { kept, dropped: Math.max(0, count - kept) };
}

/**
 * Stands in for a page whose transcription failed.
 *
 * Left in the text on purpose rather than dropped silently: the extraction pass downstream
 * reads this corpus, and a visible gap is something a person can act on, while a missing
 * page is indistinguishable from a page that happened to have no people on it.
 */
export function pageUnreadableMarker(pageNumber: number): string {
  return `[Page ${pageNumber} could not be read]`;
}

/**
 * The `sources` label the capture panel shows. Reports partial success honestly —
 * `photos:7/8` rather than a flat `photos:8` that claims more than we managed.
 */
export function scanSourceLabel(succeeded: number, total: number): string {
  return succeeded === total ? `photos:${total}` : `photos:${succeeded}/${total}`;
}
