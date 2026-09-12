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
        // Centred below md so the copy reads as one column with the solar
        // system stacked under it; md+ keeps the original left-aligned split.
        "text-center md:text-left",
        "motion-reduce:opacity-100 motion-reduce:translate-y-0"
      )}
    >
      <p className="font-[family-name:var(--font-display)] text-5xl leading-[0.95] tracking-tight text-white sm:text-6xl md:text-8xl lg:text-[5.5rem] xl:text-9xl">
        Orbit
      </p>
      <h1 className="mx-auto mt-3 max-w-xl font-[family-name:var(--font-display)] text-xl leading-snug tracking-tight text-[#e8f3f1] sm:mt-6 sm:text-2xl md:mx-0 md:mt-8 md:text-4xl">
        Keep your connections in Orbit.
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#9aada8] sm:mt-4 sm:text-base md:mx-0 md:text-lg">
        Orbit remembers every conversation and tells you who to follow up with
        — so a good connection doesn&apos;t go cold before it becomes an
        opportunity.
      </p>
      {/* Hidden below md — the fixed header carries the same two buttons at
        * every width, so on a phone this pair was pure duplication. */}
      <div className="mt-8 hidden sm:mt-10 md:block">
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
