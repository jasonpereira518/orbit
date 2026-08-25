import { auth } from "@clerk/nextjs/server";
import { MarketingDocShell } from "@/components/marketing/marketing-doc";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

/**
 * Shared chrome for the three marketing documents.
 *
 * A layout rather than per-page markup because Next keeps it mounted across
 * privacy ↔ terms ↔ contact navigations: the header, starfield and switcher
 * never remount, which is what lets the switcher's bubble animate between
 * pills instead of jumping.
 */
export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const clerkOn = isClerkConfigured();
  // Public pages: resolve auth optionally so signed-out visitors never hit a throw.
  const { userId } = clerkOn ? await auth() : { userId: null };

  return (
    <MarketingDocShell
      clerkOn={clerkOn}
      demoMode={isDemoMode()}
      signedIn={Boolean(userId)}
    >
      {children}
    </MarketingDocShell>
  );
}
