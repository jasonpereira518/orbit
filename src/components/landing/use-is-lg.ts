"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * Whether the viewport is at the `lg` breakpoint. Server-renders as false —
 * use it to gate client-only behaviour (pins, WebGL), never layout, or the
 * first paint will disagree with the markup.
 */
export function useIsLg() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}
