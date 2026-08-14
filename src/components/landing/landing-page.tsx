import { HeroPin } from "@/components/landing/hero-pin";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHeroCopy } from "@/components/landing/landing-hero";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import {
  BODY,
  KICKER,
  SceneComets,
  SceneConstellations,
  SceneFinale,
} from "@/components/landing/landing-scenes";
import { SceneFeatures } from "@/components/landing/scene-features";

// Composition root for the scroll narrative. The starfield is a fixed
// page-wide background; it must stay a direct child of this untransformed
// root (a transform/filter ancestor would re-anchor position:fixed).
// All narrative copy is server-rendered here or in the scene components.
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
    <div className="landing-root relative overflow-x-clip bg-[#05070f] text-[#e8f3f1]">
      <LandingStarfield />

      <HeroPin
        header={<LandingHeader {...authProps} />}
        heroCopy={<LandingHeroCopy {...authProps} />}
        claim={
          <>
            <p className={KICKER}>Your people</p>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,42px)] font-normal leading-[1.15] tracking-[-0.02em] text-[#e8f3f1]">
              Everyone orbits at their own distance.
            </h2>
            <p className={`${BODY} mx-auto`}>
              Orbit tracks how close you actually are — and tells you when
              it&apos;s time to pull someone back in.
            </p>
          </>
        }
      />

      <SceneConstellations />
      <SceneComets />
      <SceneFeatures />
      <SceneFinale {...authProps} />
    </div>
  );
}
