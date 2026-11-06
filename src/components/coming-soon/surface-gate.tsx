"use client";

import { usePathname } from "next/navigation";
import { surfaceForPathname } from "@/lib/surfaces";

/**
 * Shows the "coming soon" / "unavailable" screen only while the URL is still on that surface.
 *
 * `(main)/layout.tsx` decides on the server, for the path it was rendered for, whether to
 * show that screen instead of its children. But Next's client router does not re-run a
 * shared layout when navigating between two routes it wraps — so a layout that returned the
 * blocked screen once keeps returning it, and every later click (Dashboard, Contacts…)
 * fetched the right page and then had it hidden behind the old screen. The user sat on
 * "coming soon" with the nav highlighting somewhere else.
 *
 * Deciding on the client, from the live pathname, lets the cached layout output step aside
 * the moment the user leaves the surface. The page they land on does its own check
 * (`pageVisibilityGate`), which the router always re-runs.
 */
export function SurfaceGate({
  surfaceKey,
  blocked,
  children,
}: {
  surfaceKey: string;
  blocked: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return surfaceForPathname(pathname)?.key === surfaceKey ? blocked : children;
}
