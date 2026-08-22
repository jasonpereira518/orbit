import { LandingHeroCopy } from "@/components/landing/landing-hero";
import { LandingPageShell } from "@/components/landing/landing-page-shell";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
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
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />

      <LandingPageShell
        {...authProps}
        heroCopy={<LandingHeroCopy {...authProps} />}
        claim={
          <>
            {/* Keep this to the current line count. HeroPin measures the
             * claim's bottom to size the flattened system above it — a taller
             * claim silently drives the camera toward CAM_SCALE_MIN. */}
            <p className={KICKER}>Your search, mapped</p>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,42px)] font-normal leading-[1.15] tracking-[-0.02em] text-[#e8f3f1]">
              The people who can get you hired are already drifting.
            </h2>
            <p className={`${BODY} mx-auto`}>
              Orbit sorts every contact by how warm they actually are — and
              tells you which ones to pull back in before the role closes.
            </p>
          </>
        }
      >
        <SceneConstellations />
        <SceneComets />
        {/* The loop answers the pain Comets just stated — placing it before
         * that beat would turn it into a feature tour. */}
        <LandingHowItWorks />
        <SceneFeatures />
        <SceneFinale {...authProps} />
      </LandingPageShell>
    </div>
  );
}
