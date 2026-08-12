import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingFeatures } from "@/components/landing/landing-features";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
import { LandingProof } from "@/components/landing/landing-proof";
import { LandingPricingCta } from "@/components/landing/landing-pricing-cta";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingStarfield } from "@/components/landing/landing-visuals";

export function LandingPage({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#05070f] text-[#e8f3f1]">
      <LandingStarfield />
      <LandingHeader clerkOn={clerkOn} demoMode={demoMode} />
      <main>
        <LandingHero clerkOn={clerkOn} demoMode={demoMode} />
        <LandingFeatures />
        <LandingHowItWorks />
        <LandingProof />
        <LandingPricingCta clerkOn={clerkOn} demoMode={demoMode} />
      </main>
      <LandingFooter />
    </div>
  );
}
