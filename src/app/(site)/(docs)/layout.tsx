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
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Static: the signed-in variant of the header resolves in the browser (see
  // `LandingAuthControls`), so these pages need no server work at all.
  return (
    <MarketingDocShell clerkOn={isClerkConfigured()} demoMode={isDemoMode()}>
      {children}
    </MarketingDocShell>
  );
}
