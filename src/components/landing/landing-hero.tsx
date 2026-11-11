import { LandingAuthControls } from "@/components/landing/landing-auth-controls";

/** The product demo. Also linked from the page's corner (landing-page.tsx). */
export const DEMO_VIDEO = "https://youtu.be/uD0LsrTr_wo";

/**
 * The hero copy block: server-rendered, so the headline and the button ship in the document
 * and read before any script runs. The hero pin wraps it in a scrub-driven layer over the
 * scene; .landing-fade still owns the mount rise.
 *
 * The button is visible at every width. The fixed header carries one too, but on a phone
 * the hero's own is the one under the thumb.
 */
export function LandingHeroCopy({
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  return (
    <div className="landing-fade motion-reduce:translate-y-0 motion-reduce:opacity-100">
      <h1 className="max-w-3xl font-[family-name:var(--font-display)] text-[clamp(2.25rem,6vw,5rem)] font-light leading-[1.03] tracking-[-0.03em] text-balance text-white">
        Opportunity moves through people.
      </h1>
      <p className="mt-5 max-w-lg text-base leading-relaxed text-[#e8f3f1]/90 md:text-lg">
        Orbit maps everyone you know by how recently you really talked, and tells you who to
        reach out to this week, whether you want a job, an internship, or an introduction.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <LandingAuthControls
          clerkOn={clerkOn}
          demoMode={demoMode}
          signedIn={signedIn}
          variant="hero"
          mobileVisible
          primaryOnly
          primaryLabel="Create your free account"
        />
        <a
          href={DEMO_VIDEO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-full border border-white/20 bg-white/5 px-8 py-4 text-base text-[#e8f3f1] transition-colors hover:border-white/35 hover:bg-white/10"
        >
          Watch the demo
        </a>
      </div>
    </div>
  );
}
