"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
// Type only: at runtime `PrefetchKind.FULL` is the string "full", which is all this passes.
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

/**
 * Prefetching on intent — the pointer resting on something, or keyboard focus reaching it.
 *
 * Why it matters: a navigation that shows a `loading.tsx` skeleton cannot finish sooner than
 * ~300 ms, because React holds a revealed fallback on screen at least that long. On most of
 * Orbit's routes the server render takes 25–200 ms, so the skeleton, not the data, was
 * setting the wait. A click that lands on an already-prefetched route renders from the client
 * cache with no skeleton at all. A `<Link>`'s default prefetch stops at `loading.tsx` for a
 * dynamic route; these helpers upgrade the most likely next click to the WHOLE route.
 *
 * Only on intent, never for every link in view: each full prefetch is a real server render.
 */
const FULL = "full" as PrefetchKind;

/**
 * How long the pointer has to rest before a full prefetch starts, for surfaces a pointer
 * sweeps across on its way somewhere else (a long list). Short enough to leave most of a
 * deliberate click's dwell for the prefetch itself.
 */
export const LIST_INTENT_DELAY_MS = 60;

/** `router.prefetch(href)` for the whole route, not just its loading boundary. */
export function useFullPrefetch() {
  const router = useRouter();
  return useCallback((href: string) => router.prefetch(href, { kind: FULL }), [router]);
}

/**
 * Pointer/focus handlers that full-prefetch `href` once the pointer has rested `delayMs`
 * (or at once on focus or touch). Spread onto the element a person will click.
 */
export function useIntentPrefetchHandlers(href: string | null, delayMs = 0) {
  const prefetch = useFullPrefetch();
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const now = useCallback(() => {
    cancel();
    if (href) prefetch(href);
  }, [cancel, href, prefetch]);
  const onPointerEnter = useCallback(() => {
    if (!href) return;
    if (delayMs <= 0) return now();
    cancel();
    timer.current = window.setTimeout(now, delayMs);
  }, [cancel, delayMs, href, now]);
  return { onPointerEnter, onPointerLeave: cancel, onFocus: now, onTouchStart: now };
}

/**
 * For a `<Link>`: `prefetch` becomes `true` (the whole route) from the first sign of intent,
 * and stays there. Changing the prop re-registers the link with the full strategy, which
 * schedules the prefetch at once.
 */
export function useIntentLinkPrefetch<T extends boolean | "auto" | null | undefined>(
  base: T
): { prefetch: T | true; onPointerEnter: () => void; onFocus: () => void; onTouchStart: () => void } {
  const [intent, setIntent] = useState(false);
  const mark = useCallback(() => setIntent(true), []);
  return {
    prefetch: base === false ? base : intent ? true : base,
    onPointerEnter: mark,
    onFocus: mark,
    onTouchStart: mark,
  };
}
