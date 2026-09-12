import { headers } from "next/headers";
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
/** Floating ask bar + chat actions need longer than the default serverless limit. */
// TEMPORARY STOPGAP (Sept 2026): 300, not 60. Heavy accounts were hitting the 60s wall on
// /dashboard and /graph (Vercel "Task timed out after 60 seconds"); the real fix is the
// query-shape work tracked in the production-readiness plan, and this converts a hard
// error into a slow success only while that lands. Revert to 60 once `perf.slow` traces
// stay quiet for a week. 300 is the Fluid Compute ceiling on the Hobby plan.
export const maxDuration = 300;

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
  const pathname = (await headers()).get("x-pathname") ?? "";
  const surface = surfaceForPathname(pathname);
  if (surface) {
    const { hidden } = await resolveSurfaceVisibility(userId);
    if (hidden.has(surface.key)) {
      return <SurfaceUnavailable label={surface.label} />;
    }
  }

  return children;
}
