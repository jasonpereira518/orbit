import { ComingSoon } from "@/components/coming-soon/coming-soon";
import { SurfaceUnavailable } from "@/components/surface-unavailable";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { getSurface } from "@/lib/surfaces";

/**
 * Re-checks `hidden`/`comingSoon` at the page itself, on top of the group-wide gate in
 * `(main)/layout.tsx`.
 *
 * That layout gate is not enough on its own: Next's client router does not re-execute a
 * shared layout when navigating between two routes it wraps — it treats the layout segment
 * as unchanged and fetches only the target PAGE segment. So the layout's check fires on a
 * full page load or the first navigation into the group, but a `Link` click straight from,
 * say, Dashboard to Events sails past it entirely, because the click never re-runs
 * `MainAppLayout` on the server, only `EventsPage`. The PAGE segment, by contrast, is the
 * one segment Next always refetches on every navigation — it is the only place a check like
 * this is guaranteed to run. Call it first, before any data fetch, in every page.tsx a
 * `comingSoon` surface covers (currently just Events and Outreach and their children —
 * small enough to check per page; `hidden` surfaces generally still rely on the layout).
 */
export async function pageVisibilityGate(surfaceKey: string) {
  const surface = getSurface(surfaceKey);
  const userId = await requireUserId();
  const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKey)) {
    return <SurfaceUnavailable label={surface?.label} />;
  }
  if (comingSoon.has(surfaceKey)) {
    return <ComingSoon surfaceKey={surfaceKey} label={surface?.label ?? surfaceKey} />;
  }
  return null;
}
