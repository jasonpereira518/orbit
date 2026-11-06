// The full sheet. The root layout loads none, so marketing pages never pay for it (see site.css).
import "../globals.css";
import { MotionConfig } from "motion/react";
import { AuthProvider } from "@/components/auth-provider";

/**
 * The one ClerkProvider, for every route that uses Clerk.
 *
 * It used to sit in the root layout, which shipped clerk-js and its prebuilt UI bundles
 * (775 KB measured, and that is a floor) to every signed-out stranger reading the landing
 * page. Those pages now live in `(site)`, outside this group, and load none of it.
 *
 * ONE provider for the whole group, never one per route group underneath it: the
 * provider's unmount effect calls `IsomorphicClerk.clearInstance()`, so a provider per
 * group would tear Clerk down and rebuild it on every cross-group navigation. That
 * includes the `/dashboard` <-> `/pricing` <-> `/upgrade` warp, which crosses three
 * groups and all three live here, so the warp never remounts it.
 *
 * Route groups never appear in URLs, so moving routes under `(clerk)` changed no paths.
 */
export default function ClerkLayout({ children }: { children: React.ReactNode }) {
  // Reduced motion for every motion/react animation in the group: the app shell had its own,
  // but the admin console, sign-in, /suspended and checkout sit outside it.
  return (
    <AuthProvider>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </AuthProvider>
  );
}
