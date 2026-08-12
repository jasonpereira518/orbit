import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingScrollGate } from "@/components/landing/landing-scroll-gate";
import { LandingFeatures } from "@/components/landing/landing-features";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
import { LandingProof } from "@/components/landing/landing-proof";
import { LandingWaitlist } from "@/components/landing/landing-waitlist";
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
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-[#05070f] text-[#e8f3f1]"
      style={{ backgroundImage: "var(--landing-page-gradient)" }}
    >
      <LandingStarfield />
      <LandingHeader clerkOn={clerkOn} demoMode={demoMode} />
      <main>
        <LandingHero clerkOn={clerkOn} demoMode={demoMode} />
        <LandingScrollGate targetId="features" />
        <LandingFeatures />
        <LandingHowItWorks />
        <LandingProof />
        <LandingWaitlist clerkOn={clerkOn} demoMode={demoMode} />
      </main>
      <LandingFooter />
    </div>
  );
}
