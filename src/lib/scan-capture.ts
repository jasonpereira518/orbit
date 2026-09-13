/**
 * The live half of note scanning: the camera, the canvas, and PDF rasterizing.
 *
 * Browser-only, and imported only by the lazily loaded scan components so neither it nor
 * `pdfjs-dist` — which is large — rides in the app shell's bundle. The arithmetic it
 * depends on lives in `scan-image.ts`, which is DOM-free and separately tested.
 *
 * EVERY PAGE LEAVES HERE AS A JPEG, whatever arrived. That is what makes an iPhone HEIC
 * readable by OpenAI and Anthropic, what keeps an 8-page scan inside the request body
 * limit, and what stops a 12MP photo being uploaded whole over phone data. See the header
 * of `scan-image.ts` for the full reasoning.
 */
import {
  MAX_SCAN_PAGES,
  SCAN_OUTPUT_MIME,
  SCAN_PAGE_ASPECT,
  SCAN_TARGET_BYTES,
  ScanError,
  capScanPages,
  coverCrop,
  fitEdge,
  isHeicSource,
  scanEncodeAttempts,
} from "@/lib/scan-image";

export type ScanPage = {
  /** Stable across re-renders so the filmstrip can key on it and animate properly. */
  id: string;
  filename: string;
  mimeType: string;
  /** Raw base64, no data: URL prefix — what `CaptureMediaFile` expects. */
  base64: string;
  /** Object URL for the thumbnail. Revoke it with `releaseScanPage`. */
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
};

let pageSeq = 0;
function nextPageId() {
  pageSeq += 1;
  return `page-${Date.now().toString(36)}-${pageSeq}`;
}

/**
 * Whether this browser can open a camera at all.
 *
 * Checked before rendering the button, because a button that can only fail is worse than
 * no button. `isSecureContext` matters on a LAN: `getUserMedia` is unavailable over plain
 * http to an IP address, which is exactly how someone tests the QR handoff locally.
 */
export function canUseCamera(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
  return window.isSecureContext;
}

/**
 * Open the camera, preferring the one pointing away from the user.
 *
 * `ideal` rather than `exact` on facingMode: a laptop has only a front camera, and an
 * `exact` constraint would throw OverconstrainedError there rather than falling back to
 * the only camera in the building.
 */
export async function openCameraStream(): Promise<MediaStream> {
  if (!canUseCamera()) {
    throw new ScanError(
      typeof window !== "undefined" && !window.isSecureContext
        ? "insecure-context"
        : "no-camera"
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        // Ask high: handwriting is the finest detail we ever have to resolve, and the
        // downscale ladder below will bring it back down to something sendable. Height is
        // the number that counts, because a landscape webcam frame is cropped to an upright
        // page (`coverCrop`): a 1080p camera yields a page 1080 tall and only ~835 wide.
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new ScanError("camera-denied");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new ScanError("no-camera");
    }
    throw new ScanError("unknown", err instanceof Error ? err.message : undefined);
  }
}

export function stopCameraStream(stream: MediaStream | null) {
  // Every exit path. A leaked track leaves the camera indicator lit, which people
  // reasonably read as the app still watching them.
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function toBlobAsync(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), SCAN_OUTPUT_MIME, quality)
  );
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // No alpha: a photograph has none, and keeping it risks black fringing in JPEG.
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new ScanError("encode-failed", "This browser refused a 2D canvas.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // `String.fromCharCode(...bytes)` blows the argument limit on anything over ~100KB,
  // which is every page. Same chunking as `bulk-notes-panel.tsx`.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Downscale and encode until the page fits the byte target, then package it.
 *
 * Walks quality down before resolution, because handwriting survives JPEG artefacts far
 * better than it survives being resampled away. If even the smallest rung overshoots we
 * send it anyway: an oversized page that the server may still accept beats refusing to
 * read someone's notes over a byte count.
 */
async function encodePage(
  source: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
  filename: string
): Promise<ScanPage> {
  let fallback: { blob: Blob; width: number; height: number } | null = null;

  for (const { edge, quality } of scanEncodeAttempts()) {
    const { width, height } = fitEdge(naturalWidth, naturalHeight, edge);
    const canvas = drawScaled(source, width, height);
    const blob = await toBlobAsync(canvas, quality);
    if (!blob) continue;
    if (blob.size <= SCAN_TARGET_BYTES) {
      return {
        id: nextPageId(),
        filename,
        mimeType: SCAN_OUTPUT_MIME,
        base64: await blobToBase64(blob),
        previewUrl: URL.createObjectURL(blob),
        width,
        height,
        bytes: blob.size,
      };
    }
    fallback = { blob, width, height };
  }

  if (!fallback) throw new ScanError("encode-failed");
  return {
    id: nextPageId(),
    filename,
    mimeType: SCAN_OUTPUT_MIME,
    base64: await blobToBase64(fallback.blob),
    previewUrl: URL.createObjectURL(fallback.blob),
    width: fallback.width,
    height: fallback.height,
    bytes: fallback.blob.size,
  };
}

/**
 * Grab the current video frame as a page, cut to the viewfinder's shape.
 *
 * `aspect` must be the shape the `<video>` is shown in with `object-fit: cover`; the crop
 * is then exactly the part of the frame the person could see (see `coverCrop`).
 */
export async function capturePageFromVideo(
  video: HTMLVideoElement,
  aspect: number = SCAN_PAGE_ASPECT
): Promise<ScanPage> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new ScanError("decode-failed", "The camera sent no frame.");
  const crop = coverCrop(width, height, aspect);

  let source: CanvasImageSource;
  try {
    source = await createImageBitmap(video, crop.x, crop.y, crop.width, crop.height);
  } catch {
    // No createImageBitmap for a video element (older Safari): crop through a canvas.
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new ScanError("encode-failed", "This browser refused a 2D canvas.");
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    source = canvas;
  }
  try {
    return await encodePage(source, crop.width, crop.height, `photo-${Date.now()}.jpg`);
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}

/**
 * Decode a picked image file and re-encode it.
 *
 * HEIC gets its own error because the failure is the browser's, not the file's: Safari
 * decodes it natively, Chrome and Firefox cannot decode it at all. Saying so plainly beats
 * a generic "couldn't read that", because the fix — send it from the phone instead — is
 * something only the person can do, and it is one they already have a button for.
 */
export async function normalizeImageFile(file: File): Promise<ScanPage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScanError(
      isHeicSource(file.name, file.type) ? "heic-undecodable" : "decode-failed"
    );
  }
  try {
    return await encodePage(bitmap, bitmap.width, bitmap.height, file.name);
  } finally {
    bitmap.close();
  }
}

/**
 * Render each page of a PDF to an image, then treat them as photographs.
 *
 * Rasterizing here rather than sending the PDF to the model is what keeps ONE code path
 * across all three providers: OpenAI's document support needs the Responses API, which
 * this codebase does not use. It also means a PDF gets the same per-page concurrency and
 * per-page failure isolation as a stack of photos, for free.
 */
export async function rasterizePdf(file: File): Promise<{ pages: ScanPage[]; dropped: number }> {
  // Dynamically imported so pdfjs is fetched only when someone actually picks a PDF.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  // Keep the loading task: in pdfjs v6 `destroy()` lives on it, not on the document, and
  // it is what tears the worker down.
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    if (doc.numPages === 0) throw new ScanError("empty-pdf");
    const { kept, dropped } = capScanPages(doc.numPages);

    const pages: ScanPage[] = [];
    for (let n = 1; n <= kept; n++) {
      const page = await doc.getPage(n);
      // Render at the top of the ladder, then let encodePage walk it down as needed. A
      // PDF has no inherent pixel size, so this scale IS the resolution decision.
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(4, 2000 / Math.max(unit.width, unit.height));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new ScanError("encode-failed");
      // White, not transparent: a PDF page is paper, and an unpainted background would
      // encode to black once alpha is dropped.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();

      pages.push(
        await encodePage(
          canvas,
          canvas.width,
          canvas.height,
          `${file.name.replace(/\.pdf$/i, "")}-p${n}.jpg`
        )
      );
    }
    return { pages, dropped };
  } finally {
    await loadingTask.destroy();
  }
}

export function releaseScanPage(page: ScanPage) {
  URL.revokeObjectURL(page.previewUrl);
}

/**
 * Move a page earlier or later. Pure and bounds-safe: an out-of-range `to` clamps, and a
 * no-op move returns the same array. The send order is the array order.
 */
export function movePage<T>(pages: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= pages.length) return [...pages];
  const target = Math.max(0, Math.min(pages.length - 1, to));
  if (target === from) return [...pages];
  const next = [...pages];
  const [page] = next.splice(from, 1);
  next.splice(target, 0, page!);
  return next;
}

export { MAX_SCAN_PAGES };
