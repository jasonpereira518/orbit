"use client";

import { useMediaQuery } from "@/lib/use-media-query";

const QUERY = "(min-width: 1024px)";

/**
 * Whether the viewport is at the `lg` breakpoint. Server-renders as false —
 * use it to gate client-only behaviour (pins, WebGL), never layout, or the
 * first paint will disagree with the markup.
 */
export function useIsLg() {
  return useMediaQuery(QUERY);
}
