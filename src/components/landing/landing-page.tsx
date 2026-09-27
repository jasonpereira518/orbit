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

      {/* Pinned to the viewport corner on every scroll position. Must stay a
       * direct child of this untransformed root, like the starfield. */}
      <nav
        aria-label="Orbit on social"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 flex items-center"
      >
        <a
          href="https://youtu.be/uD0LsrTr_wo"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Watch the Orbit demo on YouTube"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#9aada8] transition-[color,transform] duration-150 active:scale-125 motion-reduce:active:scale-100 hover:text-[#ff0000] focus-visible:text-[#ff0000]"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-5 w-5">
            <path
              fillRule="evenodd"
              d="M7 5h10a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5ZM10 9.2v5.6L15 12Z"
            />
          </svg>
        </a>
        <a
          href="https://www.linkedin.com/in/jasonpereira518/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Jason Pereira on LinkedIn"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#9aada8] transition-[color,transform] duration-150 active:scale-125 motion-reduce:active:scale-100 hover:text-[#0a66c2] focus-visible:text-[#0a66c2]"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-5 w-5">
            <path
              fillRule="evenodd"
              d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 6.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8ZM6.7 10v7.5h2.6V10ZM11 10v7.5h2.6v-3.6c0-1 .3-1.9 1.5-1.9 1.1 0 1.3.8 1.3 1.8v3.7H19v-4.1c0-2.1-.6-3.6-2.9-3.6-1.3 0-2.2.6-2.6 1.3V10Z"
            />
          </svg>
        </a>
      </nav>
    </div>
  );
}
