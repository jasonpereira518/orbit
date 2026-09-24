"use client";

import { useLinkStatus } from "next/link";
import { cn } from "@/lib/utils";

/**
 * "I heard you" for a navigation that has not committed yet.
 *
 * Clicking a nav item could leave the previous page fully rendered, with the active
 * pill unmoved, for seconds — the pill is keyed on `pathname`, so it only moves once
 * the URL has already changed, and nothing acknowledged the click itself.
 *
 * This is a mitigation, not the fix. A sidebar click does NOT re-run `(app)/layout.tsx`
 * (shared layouts are skipped on soft navigation); what the click waits on is the
 * destination page's own server render, or — when that route's `loading.tsx` was
 * prefetched — nothing, since the skeleton shows at once. The fixes live elsewhere: the
 * client router cache (`staleTimes` in next.config.ts), full prefetching of the daily
 * routes (`prefetchFull` in app-nav.ts), and the pages' own query shape. Measured with
 * `scripts/dev/nav-timing.mjs`. This stays as the cheap acknowledgement for whatever is
 * still slow, which is exactly what the `useLinkStatus` docs recommend it for.
 *
 * Constraints from `node_modules/next/dist/docs/.../use-link-status.md`:
 *   - imports from `next/link`, NOT `next/navigation`
 *   - must be a DESCENDANT component of the `<Link>` whose status it reports
 *   - the pending phase is skipped entirely when the route is already prefetched,
 *     which is fine: this only needs to exist for the slow path
 *   - inline indicators easily cause layout shift, so this is absolutely positioned,
 *     always rendered, and toggles visibility rather than mounting
 *
 * The 100ms animation delay (see `.nav-pending-dot` in globals.css) is the documented
 * anti-flash trick: a navigation that resolves quickly never paints the dot at all.
 */
export function NavPendingDot({ className }: { className?: string }) {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden="true"
      data-pending={pending || undefined}
      className={cn("nav-pending-dot", className)}
    />
  );
}
