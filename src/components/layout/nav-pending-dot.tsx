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
 * This is a mitigation, not the fix. The underlying cause is that `(app)/layout.tsx`
 * is `force-dynamic` and awaits several database reads on the critical path of every
 * authenticated navigation, which per Next's own docs means `loading.tsx` cannot show
 * a fallback for it and navigation blocks until the layout finishes rendering. That is
 * an architecture change; this is the cheap acknowledgement in the meantime, which is
 * exactly what the `useLinkStatus` docs recommend it for.
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
