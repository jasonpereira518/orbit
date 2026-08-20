import { cn } from "@/lib/utils";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";

/**
 * The hero copy block (server-rendered — it is the page's LCP and must
 * ship visible in the document). The hero pin wraps it in a scrub-driven
 * motion container; .landing-fade still owns the mount rise.
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
    <div
      className={cn(
        "landing-fade",
        "motion-reduce:opacity-100 motion-reduce:translate-y-0"
      )}
    >
      <p className="font-[family-name:var(--font-display)] text-5xl leading-[0.95] tracking-tight text-white sm:text-6xl md:text-8xl lg:text-[5.5rem] xl:text-9xl">
        Orbit
      </p>
      <h1 className="mt-3 max-w-xl font-[family-name:var(--font-display)] text-xl leading-snug tracking-tight text-[#e8f3f1] sm:mt-6 sm:text-2xl md:mt-8 md:text-4xl">
        Keep your connections in Orbit.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-[#9aada8] sm:mt-4 sm:text-base md:text-lg">
        Orbit remembers every conversation and tells you who to follow up with
        — so a good connection doesn&apos;t go cold before it becomes an
        opportunity.
      </p>
      <div className="mt-8 hidden sm:mt-10 sm:block">
        <LandingAuthControls
          clerkOn={clerkOn}
          demoMode={demoMode}
          signedIn={signedIn}
          variant="hero"
        />
      </div>
    </div>
  );
}
