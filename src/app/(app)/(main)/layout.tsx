import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SurfaceUnavailable } from "@/components/surface-unavailable";
import { requireUserId } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceForPathname } from "@/lib/surfaces";

/**
 * First-run gate for core product routes.
 * /onboarding and /settings live outside this group so they stay reachable
 * (settings is needed for API keys; onboarding must not redirect to itself).
 *
 * AvatarBackfill lives in AppShell (above the remounting template) so nav
 * does not abort/restart background photo fills.
 */
/** Floating ask bar + chat actions need longer than the default serverless limit. */
export const maxDuration = 60;

export default async function MainAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reuses the parent layout's cached requireUserId / settings bootstrap.
  const userId = await requireUserId();

  if (await needsOnboarding(userId)) {
    redirect("/onboarding");
  }

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
