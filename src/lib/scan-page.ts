/**
 * The scanned-page shape and the two small helpers that handle one, split out of
 * `scan-capture.ts` so the chat and capture panels can hold pages without statically pulling
 * the camera, canvas and PDF code (and `scan-image`) into their bundles. DOM-free apart from
 * `URL.revokeObjectURL`. `scan-capture.ts` re-exports all three, so its importers are unchanged.
 */

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
