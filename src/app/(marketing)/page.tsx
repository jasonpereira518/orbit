import { LandingPage } from "@/components/landing/landing-page";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

export default async function MarketingPage() {
  return (
    <LandingPage clerkOn={isClerkConfigured()} demoMode={isDemoMode()} />
  );
}
