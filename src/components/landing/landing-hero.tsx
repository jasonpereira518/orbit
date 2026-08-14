import Link from "next/link";
import { cn } from "@/lib/utils";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { LandingHeader } from "@/components/landing/landing-header";
import {
  LandingSolarSystem,
  LandingStarfield,
} from "@/components/landing/landing-visuals";

export function LandingHero({
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  return (
    <div className="relative flex min-h-svh flex-col overflow-x-clip bg-[#05070f] text-[#e8f3f1]">
      <LandingStarfield />

      <LandingHeader clerkOn={clerkOn} demoMode={demoMode} signedIn={signedIn} />

      <main className="relative z-10 flex flex-1 flex-col justify-center px-6 pb-8 pt-4 md:px-10 md:pb-10">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
          <div
            className={cn(
              "landing-fade max-w-3xl",
              "motion-reduce:opacity-100 motion-reduce:translate-y-0"
            )}
          >
            <p className="font-[family-name:var(--font-display)] text-6xl leading-[0.95] tracking-tight text-white sm:text-7xl md:text-8xl lg:text-[5.5rem] xl:text-9xl">
              Orbit
            </p>
            <h1 className="mt-6 max-w-xl font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] sm:mt-8 sm:text-3xl md:text-4xl">
              Keep every connection in orbit.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-[#9aada8] sm:text-lg">
              Your people, your last conversation, your next follow-up — all in one place.
            </p>
            <div className="mt-8 sm:mt-10">
              <LandingAuthControls
                clerkOn={clerkOn}
                demoMode={demoMode}
                signedIn={signedIn}
                variant="hero"
              />
            </div>
          </div>

          <LandingSolarSystem className="w-full max-w-[min(100%,560px)] lg:max-w-[580px] lg:justify-self-end" />
        </div>
      </main>

      <div className="relative z-10 flex items-center justify-between px-6 pb-5 md:px-10 md:pb-8">
        <Link
          href="/privacy"
          className="text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]"
        >
          Privacy
        </Link>
        <a
          href="https://jasonpereira.live/"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-credit-shimmer text-sm"
        >
          By Jason Pereira
        </a>
      </div>
    </div>
  );
}
