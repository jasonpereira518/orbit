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
 * size `encodePage` walks its ladder down to hit, so that a full scan never has to discover
 * the request limit the hard way. Only the pathological page that is still over target at
 * the bottom of the ladder exceeds it, which is what makes `SCAN_PAGE_BUDGET_BYTES` below a
 * sound worst case rather than an average.
 */
export const SCAN_TARGET_BYTES = 1_200_000;

/** Everything is re-encoded to this. See the file header. */
export const SCAN_OUTPUT_MIME = "image/jpeg";

/**
 * Pages per scan. The single source of truth: `capture-ingest` imports this rather than
 * keeping its own copy, so the client's page counter and the server's slice cannot drift.
 *
 * ## Why 12, and what would have to change to go higher
 *
 * Three ceilings bound this, and 12 is the largest number that clears all three with room
 * left over. `scripts/smoke-scan-image.ts` asserts the first one rather than trusting this
 * comment to stay true.
 *
 *   1. THE REQUEST. Every page rides in one upload, so the worst case is
 *      `MAX_SCAN_PAGES * SCAN_TARGET_BYTES` = 14.4MB against `CAPTURE_MAX_UPLOAD_BYTES` of
 *      22MB, leaving headroom for the `.txt`/`.ics` files that can share a note. 18 pages
 *      would be 21.6MB, which clears the cap by less than one page — too close to a number
 *      a person can push against.
 *   2. THE FUNCTION. Transcription runs inside `POST /api/capture/jobs`, whose
 *      `maxDuration` is 300s, at `TRANSCRIBE_CONCURRENCY = 3`. 12 pages is four waves where
 *      8 was three; the extra wave is tens of seconds against a five-minute budget that
 *      also has to cover extraction under `autoQueue`.
 *   3. THE BILL. A page is a vision call against the user's own key. 12 is roughly a
 *      scanned meeting agenda or a photographed notebook spread; past that the honest
 *      answer is a second note, not a bigger one.
 *
 * NOT the number of pages in a PDF somebody has. A long report still truncates — see
 * `capScanPages`, whose `dropped` count exists so that truncation is always said out loud.
 */
export const MAX_SCAN_PAGES = 12;

/**
 * The most a prepared set of pages can weigh, and the reason the sorting dialog can size a
 * note it has not encoded yet.
 *
 * A picked file's size on disk says almost nothing about what it costs to upload: a 5MB
 * phone photo re-encodes to well under `SCAN_TARGET_BYTES`, and a 2MB PDF explodes into
 * twelve pages that weigh far more than it did. Both directions matter — one blocks a drop
 * that would have been fine, the other waves through one that will not fit — so
 * `estimatePreparedBytes` prices the visual half of a note at this bound instead of at what
 * the file manager reports. See `src/lib/capture/prepare-upload.ts`.
 */
export const SCAN_PAGE_BUDGET_BYTES = MAX_SCAN_PAGES * SCAN_TARGET_BYTES;

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

/**
 * The webcam viewfinder's shape: a US Letter page held upright, 8.5 wide by 11 tall.
 *
 * Letter rather than A4 because it is the wider of the two, so an A4 page (1:√2) also fits
 * inside it with room at the sides — the frame is somewhere a page goes, not a stencil it
 * has to match.
 */
export const SCAN_PAGE_ASPECT = 8.5 / 11;

export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * The centred region of a `width`×`height` frame that `object-fit: cover` shows in a box
 * whose shape is `aspect` (width ÷ height).
 *
 * The captured page is cut to exactly this, so the photo is what the viewfinder showed.
 * A laptop webcam sends a landscape frame; without the crop, a page the person carefully
 * lined up in a portrait frame would arrive with a desk on either side of it.
 */
export function coverCrop(width: number, height: number, aspect: number): CropRect {
  if (width <= 0 || height <= 0 || !(aspect > 0)) {
    return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
  }
  if (width / height > aspect) {
    // Wider than the box: keep the full height, trim the sides.
    const cropWidth = Math.max(1, Math.min(width, Math.round(height * aspect)));
    return { x: Math.floor((width - cropWidth) / 2), y: 0, width: cropWidth, height };
  }
  // Taller than the box: keep the full width, trim top and bottom.
  const cropHeight = Math.max(1, Math.min(height, Math.round(width / aspect)));
  return { x: 0, y: Math.floor((height - cropHeight) / 2), width, height: cropHeight };
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

/**
 * How many of `count` pages we will actually read, and how many fall off the end.
 *
 * `budget` is for the caller that has already spent part of the allowance on other files in
 * the same note — a bin holding four photos and a PDF has eight pages left for the PDF, not
 * twelve. It is clamped to `MAX_SCAN_PAGES`, so no caller can talk its way past the cap.
 */
export function capScanPages(count: number, budget = MAX_SCAN_PAGES): PageCap {
  const allowed = Math.max(0, Math.min(budget, MAX_SCAN_PAGES));
  const kept = Math.max(0, Math.min(count, allowed));
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
