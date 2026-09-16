"use client";

import { useEffect, useState } from "react";
import { useMediaQuery } from "@/lib/use-media-query";

/**
 * When the constellation swaps its React Flow chart for the canvas renderer.
 *
 * The second clause is load-bearing and is why this is not a plain `md` query. An
 * iPhone rotated to landscape is 812×375: it clears a width-only breakpoint and would
 * swap *back* into the DOM chart on the exact device that cannot survive it. Pairing a
 * short viewport with a coarse pointer latches phones to the canvas in both
 * orientations, while a 768×1024 iPad and a short desktop window (fine pointer) both
 * stay on React Flow.
 *
 * 767.98 rather than 767 because a media query compares against fractional CSS pixels;
 * a 767.5px viewport is below `md` and must match.
 *
 * Keep in sync with `isSmallSkyViewport` below — that is the testable half.
 */
export const SMALL_SKY_QUERY =
  "(max-width: 767.98px), (max-height: 767.98px) and (pointer: coarse)";

/** Tailwind's `md`, as the number the query above encodes. */
export const SMALL_SKY_MAX_PX = 767.98;

/**
 * How long a viewport must stay large before the canvas hands back to React Flow.
 *
 * Asymmetric on purpose. Entering the canvas frees memory and should be instant;
 * leaving it mounts React Flow and rebuilds the chart, which must never be triggered by
 * a soft-keyboard open, a URL-bar collapse, or a rotation transient.
 */
export const SMALL_SKY_EXIT_MS = 250;

/**
 * The pure form of `SMALL_SKY_QUERY`, so the decision is assertable without a DOM.
 * `scripts/smoke-graph-canvas.ts` pins the device cases against this.
 */
export function isSmallSkyViewport(viewport: {
  width: number;
  height: number;
  coarsePointer: boolean;
}): boolean {
  const { width, height, coarsePointer } = viewport;
  return width <= SMALL_SKY_MAX_PX || (height <= SMALL_SKY_MAX_PX && coarsePointer);
}

/**
 * Whether this viewport gets the canvas constellation.
 *
 * Safe to call during render: `NetworkGraph` is only ever reached through
 * `next/dynamic({ ssr: false })`, so the first render happens in the browser and the
 * answer is right on frame one — no flash, no double mount.
 */
export function useSmallSky(): boolean {
  const raw = useMediaQuery(SMALL_SKY_QUERY);
  const [latched, setLatched] = useState(raw);

  // Entering the canvas is adjusted during render rather than in an effect, so a phone
  // never paints even one frame of the renderer it cannot afford.
  if (raw && !latched) setLatched(true);

  useEffect(() => {
    if (raw) return;
    const timer = setTimeout(() => setLatched(false), SMALL_SKY_EXIT_MS);
    return () => clearTimeout(timer);
  }, [raw]);

  return latched;
}
