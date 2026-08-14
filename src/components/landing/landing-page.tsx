import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import {
  SceneComets,
  SceneConstellations,
  SceneFinale,
} from "@/components/landing/landing-scenes";

// Composition root for the scroll narrative. The starfield is a fixed
// page-wide background; it must stay a direct child of this untransformed
// root (a transform/filter ancestor would re-anchor position:fixed).
export function LandingPage({
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  const authProps = { clerkOn, demoMode, signedIn };

  return (
    <div className="relative overflow-x-clip bg-[#05070f] text-[#e8f3f1]">
      <LandingStarfield />

      <div className="flex min-h-svh flex-col">
        <LandingHeader {...authProps} />
        <LandingHero {...authProps} />
      </div>

      <SceneConstellations />
      <SceneComets />
      <SceneFinale {...authProps} />
    </div>
  );
}
