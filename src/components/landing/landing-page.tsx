import { EarlyAccessPill } from "@/components/landing/early-access-pill";
import { GlassCard } from "@/components/landing/glass-card";
import { RINGS } from "@/components/landing/hero-choreography";
import { DEMO_VIDEO, LandingHeroCopy } from "@/components/landing/landing-hero";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
import { LandingPageShell } from "@/components/landing/landing-page-shell";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import {
  BODY,
  HEADING,
  SceneAlso,
  SceneConstellations,
  SceneFinale,
  ScenePrice,
} from "@/components/landing/landing-scenes";
import { DORMANT_DAYS } from "@/lib/outreach-thresholds";

// Composition root for the scroll narrative: out from the star (the pinned hero and its
// three beats), into the deep sky (constellations), how it works, what else ships, the
// price, and home. The starfield is a fixed page-wide background; it must stay a direct
// child of this untransformed root (a transform/filter ancestor would re-anchor
// position:fixed). All narrative copy is server-rendered here or in the scene components.
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

  // Clipped on both axes: `clip`, unlike `hidden`, creates no scroll container, so the
  // sticky frame inside keeps working.
  return (
    <div className="landing-root relative overflow-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />

      <LandingPageShell
        {...authProps}
        heroCopy={<LandingHeroCopy {...authProps} />}
        claim={
          <>
            <h2 className={HEADING}>Everyone you know, by warmth.</h2>
            <p className={BODY}>
              Orbit reads your email, calendar and LinkedIn history and places each person by
              your last real conversation. When someone has been quiet for {DORMANT_DAYS} days,
              it tells you.
            </p>
            {/* The ring labels over the scene are positioned by it and hidden from assistive
              * tech; this says the same thing in the document. */}
            <p className="sr-only">
              Three orbits: {RINGS.map((ring) => `${ring.name}, ${ring.note}`).join("; ")}.
            </p>
          </>
        }
        cometClaim={
          <>
            <h2 className={HEADING}>A good contact cools fast.</h2>
            <p className={BODY}>
              A month after a great conversation you are close to a stranger again. Orbit
              watches the gap and brings the person back while the introduction is still
              possible.
            </p>
            {/* landing-glass, not liquid-glass: liquid-glass's light variant has no `.dark`
              * ancestor to invert against on this page. The person is sample data. */}
            <GlassCard className="mt-8 max-w-sm rounded-2xl p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0f3d3e] text-sm font-medium text-[#e8f3f1]">
                  PR
                </div>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="text-sm font-medium text-[#e8f3f1]">Priya Raman</p>
                  <p className="text-sm text-[#e8f3f1]/85">Coffee chat, 5 weeks ago</p>
                </div>
                <span className="shrink-0 rounded-full bg-[#f2c14e]/15 px-3 py-1 text-sm text-[#f2c14e]">
                  Follow up today
                </span>
              </div>
            </GlassCard>
          </>
        }
      >
        <SceneConstellations />
        <LandingHowItWorks />
        <SceneAlso />
        <ScenePrice />
        <SceneFinale {...authProps} />
      </LandingPageShell>

      {/* Phones only: a fade behind the pill and the social icons below. Without it the page
       * scrolled straight under them, and body text ran into the pill and the icons. The
       * landing's scroll-padding (theme.css) keeps a focused link above it too. */}
      <div
        aria-hidden
        data-landing-bottom-fade
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 h-[calc(5rem+env(safe-area-inset-bottom))] bg-gradient-to-t from-[#03050c] via-[#03050c]/85 to-transparent md:hidden [[data-pass-seen]_&]:h-[calc(4rem+env(safe-area-inset-bottom))]"
      />

      {/* Its own landmark: a fixed corner link outside <main>, which must stay a direct
       * child of this untransformed root. */}
      <aside aria-label="Early access">
        <EarlyAccessPill />
      </aside>

      {/* Pinned to the viewport corner on every scroll position. Must stay a
       * direct child of this untransformed root, like the starfield. */}
      <nav
        aria-label="Orbit on social"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 flex items-center"
      >
        <a
          href={DEMO_VIDEO}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Watch the Orbit demo on YouTube"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#9aada8] transition-[color,transform] duration-150 ease hover:scale-110 hover:text-[#ff0000] focus-visible:scale-110 focus-visible:text-[#ff0000] active:scale-125 motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100 motion-reduce:active:scale-100"
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
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#9aada8] transition-[color,transform] duration-150 ease hover:scale-110 hover:text-[#0a66c2] focus-visible:scale-110 focus-visible:text-[#0a66c2] active:scale-125 motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100 motion-reduce:active:scale-100"
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
