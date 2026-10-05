"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * How old a page may be when it lands before it is quietly re-read. A click usually follows
 * the hover that prefetched it by well under a second, so a prefetched page arrives inside
 * this and costs nothing more; one hovered long ago, or a revisit served from the router
 * cache, is older and gets refreshed.
 */
export const FRESH_ON_ARRIVAL_MS = 2_000;

/**
 * The smallest (client clock − server render time) seen in this tab. It stands for clock skew
 * plus the quickest delivery, so a page's AGE is how far its own offset exceeds it — no
 * assumption that the server's and the browser's clocks agree. The tab's first page is a
 * fresh server render by definition, so the baseline starts honest and only tightens.
 */
let baseline: number | null = null;
/** Stamps already refreshed once, so a failed refresh can never turn into a loop. */
const refreshed = new Set<number>();

/**
 * Stale-while-revalidate for whole pages. Prefetching (on hover, and the sidebar's full
 * prefetch) and the router cache (`staleTimes`) let a click show a page rendered some time
 * ago, instantly. This keeps the instant part and drops the "some time ago": when the page on
 * screen was rendered more than `FRESH_ON_ARRIVAL_MS` before it arrived, `router.refresh()`
 * re-reads it in the background. The cached page stays up meanwhile — no skeleton, scroll and
 * client state kept — and the fresh one replaces it as soon as the server answers.
 *
 * Rendered by `<RenderStamp />`, one per page; see `render-stamp.tsx`.
 */
export function FreshOnArrival({ renderedAt }: { renderedAt: number }) {
  const router = useRouter();
  useEffect(() => {
    const offset = Date.now() - renderedAt;
    if (baseline === null || offset < baseline) baseline = offset;
    if (offset - baseline <= FRESH_ON_ARRIVAL_MS || refreshed.has(renderedAt)) return;
    refreshed.add(renderedAt);
    router.refresh();
  }, [renderedAt, router]);
  return null;
}
