import { LandingPage } from "@/components/landing/landing-page";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

/**
 * Static, and served from the CDN. It used to call `auth()` so a signed-in visitor saw
 * "Open app" from the first frame — which made the most-visited page in the product a
 * server render for everyone. The auth controls now resolve the signed-in variant in the
 * browser after hydration (`LandingAuthControls`); the rare signed-in visitor sees the
 * signed-out buttons for a few hundred milliseconds, and everyone gets a cached page.
 */
export default function MarketingPage() {
  return <LandingPage clerkOn={isClerkConfigured()} demoMode={isDemoMode()} />;
}
