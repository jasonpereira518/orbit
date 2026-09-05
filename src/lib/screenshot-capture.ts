/**
 * Grabbing one frame of the screen, cropping it, and encoding the result.
 *
 * Browser-only, and imported only by the lazily loaded capture components so it never rides
 * in the app shell's bundle.
 *
 * WHY NOT A DOM RASTERIZER. html2canvas and friends redraw the DOM into a canvas, which
 * needs no permission prompt and would have been simpler. They also cannot render
 * `backdrop-filter`, `<canvas>`, or WebGL — which in Orbit means the liquid-glass chrome,
 * the starfield and the globe all come out blank or wrong. The screenshots would be least
 * trustworthy on exactly the surfaces someone is most likely to be reporting.
 */

export type CapturedFrame = {
  /** The full captured surface. `close()` it when done — a 4K bitmap is ~33MB. */
  source: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
  /** An object URL for the full frame, for the selection overlay to draw. */
  previewUrl: string;
};

export type CaptureFailure =
  | "cancelled"
  | "unsupported"
  | "no-source"
  | "timeout"
  | "empty-frame"
  | "too-large"
  | "unknown";

export class CaptureError extends Error {
  readonly reason: CaptureFailure;
  constructor(reason: CaptureFailure, message?: string) {
    super(message ?? reason);
    this.name = "CaptureError";
    this.reason = reason;
  }
}

/** Longest edge of a stored screenshot, and the ladder we walk down to fit the byte cap. */
export const SCREENSHOT_EDGE_LADDER = [1280, 1024, 800] as const;
const QUALITY_LADDER = [0.82, 0.7, 0.6, 0.5] as const;

/** Below this, in displayed CSS pixels, a drag is a stray click rather than a selection. */
export const MIN_SELECTION_PX = 24;

/**
 * Can this browser capture the screen at all?
 *
 * Desktop only: `getDisplayMedia` does not exist on iOS in any browser, and is absent or
 * inert on Android. The form asks this before rendering an "Add screenshot" button, because
 * a button that can only fail is worse than no button.
 */
export function canCaptureScreen(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  if (!window.isSecureContext) return false;
  return window.matchMedia("(min-width: 768px)").matches;
}

async function requestDisplayStream(): Promise<MediaStream> {
  const dpr = window.devicePixelRatio || 1;
  const options = {
    audio: false,
    video: {
      displaySurface: "browser",
      // Ask for native-resolution pixels so HiDPI text is not pre-blurred by the capturer.
      // No frameRate constraint: a low `ideal` fps can delay the first frame by up to 1/fps
      // seconds, and one frame is all we ever want.
      width: { ideal: Math.min(3840, Math.round(window.innerWidth * dpr)) },
      height: { ideal: Math.min(2160, Math.round(window.innerHeight * dpr)) },
    },
    // Chromium collapses the picker to a one-click "Share this tab?" prompt. WebIDL ignores
    // unknown dictionary members, so Safari and Firefox silently fall back to the full
    // picker and the person chooses the tab themselves.
    preferCurrentTab: true,
    surfaceSwitching: "exclude",
  } as DisplayMediaStreamOptions;

  try {
    return await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    // Chromium throws TypeError for illegal constraint combinations, BEFORE showing any
    // prompt — so the transient activation is still live and a plain retry works.
    if (err instanceof TypeError) {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    throw err;
  }
}

/**
 * Resolve once the video has a frame that can actually be painted.
 *
 * `loadedmetadata` only means the dimensions are known; `requestVideoFrameCallback` is the
 * only signal that a frame is presentable. Chrome 83+, Safari 15.4+, Firefox 132+, with a
 * `loadeddata` + rAF fallback for anything older.
 */
function waitForFirstFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureError("timeout")), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const withRvfc = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof withRvfc.requestVideoFrameCallback === "function") {
      withRvfc.requestVideoFrameCallback(done);
    } else {
      video.addEventListener("loadeddata", () => requestAnimationFrame(done), { once: true });
    }
  });
}

function makeCanvas(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  // Screenshots have no alpha. Dropping it makes the WebP smaller and avoids black
  // fringing if we fall back to JPEG.
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new CaptureError("unknown", "This browser refused a 2D canvas.");
  draw(ctx);
  return canvas;
}

function blobToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new CaptureError("empty-frame"));
      else resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

/**
 * Take exactly one frame of whatever surface the person shares, then stop sharing.
 *
 * `<video>` + canvas rather than `ImageCapture.grabFrame()`, which is Chromium-only —
 * Safari has never shipped it and Firefox keeps it behind a pref — and which races
 * track-muted state even where it exists.
 *
 * MUST be called from a user gesture: `getDisplayMedia` requires transient activation.
 */
export async function captureOneFrame(): Promise<CapturedFrame> {
  if (!canCaptureScreen()) throw new CaptureError("unsupported");

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;

  try {
    try {
      stream = await requestDisplayStream();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError") throw new CaptureError("cancelled");
      if (name === "NotFoundError") throw new CaptureError("no-source");
      if (name === "NotSupportedError" || name === "TypeError") {
        throw new CaptureError("unsupported");
      }
      throw new CaptureError("unknown", err instanceof Error ? err.message : undefined);
    }

    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    // Off-screen, NOT `display: none` — a hidden video stops delivering frames in Safari
    // and is aggressively throttled in Chromium.
    video.style.cssText =
      "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    video.srcObject = stream;
    await video.play();

    await waitForFirstFrame(video, 5000);
    if (!video.videoWidth || !video.videoHeight) throw new CaptureError("empty-frame");

    const width = video.videoWidth;
    const height = video.videoHeight;

    let source: ImageBitmap | HTMLCanvasElement;
    try {
      source = await createImageBitmap(video);
    } catch {
      // Older engines without createImageBitmap(HTMLVideoElement).
      const frame = video;
      source = makeCanvas(width, height, (ctx) => ctx.drawImage(frame, 0, 0));
    }

    const previewUrl = await blobToUrl(
      makeCanvas(width, height, (ctx) => ctx.drawImage(source as CanvasImageSource, 0, 0))
    );

    return { source, width, height, previewUrl };
  } finally {
    // Every exit path. A leaked track leaves Chrome's "Stop sharing" bar and blue border
    // up, which people reasonably read as the app still watching them.
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (video) {
      video.srcObject = null;
      video.remove();
    }
  }
}

export function releaseFrame(frame: CapturedFrame | null) {
  if (!frame) return;
  URL.revokeObjectURL(frame.previewUrl);
  if ("close" in frame.source) frame.source.close();
}

export type CropRect = { x: number; y: number; w: number; h: number };

export type Viewport = { width: number; height: number };
/** Where the frozen still is painted, in viewport CSS pixels. */
export type FitGeometry = { scale: number; left: number; top: number };

/**
 * Place a captured frame so the whole of it is on screen, centred.
 *
 * A shared tab is captured at exactly the viewport's aspect ratio (viewport x
 * devicePixelRatio), so `scale` comes out as 1/dpr, `left` and `top` come out zero, and
 * the still lands pixel-for-pixel on top of the page it is a picture of — dragging feels
 * like dragging on the live page. That case is the common one and is unaffected by
 * anything below.
 *
 * A shared MONITOR is the case this exists for. Its aspect ratio does not match the
 * window, so there is a real choice: cover the window and crop the still's edges away, or
 * contain it and letterbox. It covered, which read as being zoomed into the middle of your
 * own screenshot with the edges unreachable. It contains now — see the note in the body.
 *
 * An even earlier version contained it but ALSO padded it and refused to upscale, which
 * shrank the still to a miniature the pointer could not agree with. Containing is not that:
 * one axis still meets the window exactly, and the scale is honest at every window size.
 *
 * Pure, and takes the viewport explicitly rather than reading `window`, so the mapping is
 * checkable without a browser — see `scripts/smoke-feedback-image.ts`.
 */
export function fitGeometry(frame: Viewport, viewport: Viewport): FitGeometry {
  // `min` contains rather than covers: the WHOLE still has to be on screen, because you
  // cannot drag a box around a part of it you cannot see. This used to be `max`, which
  // aligned a shared-tab capture pixel-for-pixel with the live page — but a shared monitor
  // has a different aspect ratio, and covering then cropped its edges off the window with
  // no way to reach them. Alignment is worth less than reach: by the time this overlay is
  // up, the still is a photograph, not the page.
  //
  // When the aspect ratios DO match — sharing this tab, the common case — `min` and `max`
  // are the same number, so that path is unchanged and still lands at true scale.
  //
  // The crop is always taken from the original frame pixels, whatever size it is shown at,
  // so containing costs no resolution.
  const scale = Math.min(viewport.width / frame.width, viewport.height / frame.height);
  return {
    scale,
    left: (viewport.width - frame.width * scale) / 2,
    top: (viewport.height - frame.height * scale) / 2,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * A rectangle in viewport coordinates → the frame pixels under it.
 *
 * Clamped to the frame because pointer capture lets a drag continue outside the window,
 * and because a desktop-share still overflows the viewport on one axis.
 */
export function selectionToCrop(
  selection: { left: number; top: number; width: number; height: number },
  geometry: FitGeometry,
  frame: Viewport
): CropRect {
  const { scale, left, top } = geometry;
  const x = clamp(Math.round((selection.left - left) / scale), 0, frame.width);
  const y = clamp(Math.round((selection.top - top) / scale), 0, frame.height);
  return {
    x,
    y,
    w: clamp(Math.round(selection.width / scale), 1, frame.width - x),
    h: clamp(Math.round(selection.height / scale), 1, frame.height - y),
  };
}
/** A redaction, in 0–1 of the CROP, so it survives the downscale ladder unchanged. */
export type NormalizedRect = { x: number; y: number; w: number; h: number };

/**
 * Crop and scale in one pipeline, halving on the way down.
 *
 * A single-step 2560→1280 `drawImage` aliases badly, and a screenshot is close to 100%
 * text — the worst case for it. Repeated halving costs a few milliseconds and is the
 * difference between readable and not.
 */
function drawScaled(
  source: CanvasImageSource,
  crop: CropRect,
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  let current = makeCanvas(crop.w, crop.h, (ctx) =>
    ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
  );
  let w = crop.w;
  let h = crop.h;

  while (w > targetW * 2 && h > targetH * 2) {
    const nw = Math.max(targetW, Math.floor(w / 2));
    const nh = Math.max(targetH, Math.floor(h / 2));
    const previous = current;
    const pw = w;
    const ph = h;
    current = makeCanvas(nw, nh, (ctx) => {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(previous, 0, 0, pw, ph, 0, 0, nw, nh);
    });
    w = nw;
    h = nh;
  }

  const last = current;
  const lw = w;
  const lh = h;
  return makeCanvas(targetW, targetH, (ctx) => {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(last, 0, 0, lw, lh, 0, 0, targetW, targetH);
  });
}

/** Paint the opaque redaction boxes. Solid, not blurred — see `ScreenshotAnnotator`. */
function paintRedactions(canvas: HTMLCanvasElement, rects: NormalizedRect[]) {
  if (rects.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#111827";
  for (const r of rects) {
    ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
  }
}

function toBlobAsync(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Encode once, and trust the RESULT rather than a capability probe.
 *
 * Safari 14–16.3 silently returns a PNG from `toBlob(canvas, "image/webp")` instead of
 * refusing, so the only reliable test is what type came back.
 */
async function encodeOnce(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const webp = await toBlobAsync(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlobAsync(canvas, "image/jpeg", quality);
  if (!jpeg) throw new CaptureError("unknown", "This browser could not encode the image.");
  return jpeg;
}

export type EncodedShot = {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

/**
 * Crop, redact, downscale and encode, walking down until it fits the per-shot byte cap.
 *
 * Throws `CaptureError("too-large")` when even 800px at q=0.5 will not fit — better than
 * silently storing something nobody can read.
 */
export async function cropDownscaleEncode(
  frame: CapturedFrame,
  crop: CropRect,
  redactions: NormalizedRect[],
  maxBytes: number
): Promise<EncodedShot> {
  for (const edge of SCREENSHOT_EDGE_LADDER) {
    const scale = Math.min(1, edge / Math.max(crop.w, crop.h));
    const width = Math.max(1, Math.round(crop.w * scale));
    const height = Math.max(1, Math.round(crop.h * scale));
    const canvas = drawScaled(frame.source as CanvasImageSource, crop, width, height);
    paintRedactions(canvas, redactions);

    for (const quality of QUALITY_LADDER) {
      const blob = await encodeOnce(canvas, quality);
      if (blob.size <= maxBytes) {
        return { blob, width, height, bytes: blob.size, mimeType: blob.type };
      }
    }
  }
  throw new CaptureError("too-large");
}

/**
 * Blob → base64 data URL, in chunks.
 *
 * `String.fromCharCode(...bytes)` blows the argument limit on anything over ~100KB, which
 * is every screenshot. Same shape as the helper in `bulk-notes-panel.tsx`.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
