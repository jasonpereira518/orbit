import type { CSSProperties } from "react";
import { SCAN_PAGE_ASPECT } from "@/lib/scan-image";

/**
 * The webcam viewfinder's box: an upright page, as wide as the dialog allows but never
 * taller than most of the screen, since a laptop display is short and the shutter, the
 * page strip and the buttons all have to fit under it.
 *
 * Sized from `SCAN_PAGE_ASPECT` rather than a Tailwind aspect utility so the box
 * people line the page up in and the crop `capturePageFromVideo` takes can never disagree.
 * Shared by the camera and its loading skeleton, so the dialog does not change size when
 * the camera chunk arrives.
 */
export const VIEWFINDER_STYLE: CSSProperties = {
  aspectRatio: String(SCAN_PAGE_ASPECT),
  width: `min(100%, calc(min(58dvh, 34rem) * ${SCAN_PAGE_ASPECT}))`,
};
