import { LandingHero } from "@/components/landing/landing-hero";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

export default async function MarketingPage() {
  return (
    <LandingHero clerkOn={isClerkConfigured()} demoMode={isDemoMode()} />
  );
}
