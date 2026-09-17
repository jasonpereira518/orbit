import { headers } from "next/headers";
import { ComingSoon } from "@/components/coming-soon/coming-soon";
import { SurfaceUnavailable } from "@/components/surface-unavailable";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceForPathname } from "@/lib/surfaces";

/**
 * The first-run gate for these routes lives one level up, in `(app)/layout.tsx` — it has to
 * run before `<AppShell>` renders or the redirect turns into a client-side one that crashes
 * Next's router during hydration. See the comment there.
 *
 * AvatarBackfill lives in AppShell (above the remounting template) so nav
 * does not abort/restart background photo fills.
 */
/**
 * Floating ask bar + chat actions need longer than the default serverless limit.
 *
 * Back to 60. This was 300 as a stopgap while heavy accounts hit the 60-second wall on
 * /dashboard — the dashboard loaded every contact in the account and did its filtering,
 * sorting and aggregation in JavaScript, so the work grew with the network and a large one
 * ran out of function. That is fixed: the payload is bounded now (see the "Payload scaling"
 * section of scripts/smoke-page-budgets.ts, which fails if it starts growing again), and
 * 300 was only ever converting a hard error into a slow success.
 *
 * /graph is NOT fixed and does not need this: its "show all" scope means all by design, and
 * it has its own scope toggle so the default view is the bounded one.
 */
export const maxDuration = 60;

export default async function MainAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reuses the parent layout's cached requireUserId / settings bootstrap.
  const userId = await requireUserId();

  // Route-level half of surface visibility. One check here covers every page in the group
  // AND its dynamic children — hiding Contacts closes `/contacts/[id]` and `/contacts/new`
  // with it, which a per-page guard would have to remember to do ten more times.
  //
  // `x-pathname` is set by `src/proxy.ts` on every matched request. Reading the pathname in
  // a layout is otherwise impossible in the App Router: layouts do not receive it, and
  // `usePathname` is client-side. The group is already `force-dynamic`, so reading a header
  // forfeits no caching.
  //
  // NOT sufficient on its own, though: Next's client router does not re-execute a shared
  // layout when navigating between two routes it wraps, so a `Link` click from, say,
  // Dashboard straight to Events never re-runs this function at all — only the target
  // page's own segment gets refetched. This still covers a full page load (including a
  // hidden/coming-soon URL typed or bookmarked directly) and every OTHER route in the
  // group, so it stays; `comingSoon` additionally re-checks itself at the page level
  // (`pageVisibilityGate` in `src/components/coming-soon/page-gate.tsx`) precisely because
  // it is reached by exactly this kind of sibling click from the nav.
  const pathname = (await headers()).get("x-pathname") ?? "";
  const surface = surfaceForPathname(pathname);
  if (surface) {
    const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
    if (hidden.has(surface.key)) {
      return <SurfaceUnavailable label={surface.label} />;
    }
    // After `hidden` on purpose: a page an operator switched off is off, announced or not.
    if (comingSoon.has(surface.key)) {
      return <ComingSoon surfaceKey={surface.key} label={surface.label} />;
    }
  }

  return children;
}
