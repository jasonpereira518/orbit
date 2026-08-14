import Link from "next/link";
import { CometStreak } from "@/components/landing/comet-streak";
import { ConstellationFigure } from "@/components/landing/constellation-figure";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { Reveal } from "@/components/motion/reveal";

// All narrative copy is server-rendered here so it ships in the document;
// <Reveal> only choreographs when it becomes visible.

export const KICKER = "text-xs uppercase tracking-[0.16em] text-[#c4a35a]";
export const HEADING =
  "mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]";
export const BODY = "mt-4 max-w-md text-base leading-relaxed text-[#9aada8] sm:text-lg";

export function SceneConstellations() {
  return (
    <section
      aria-labelledby="landing-groups"
      className="landing-scene relative z-10 flex min-h-[90svh] items-center px-6 py-24 md:px-10"
    >
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
        <div>
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Clusters</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="landing-groups" className={HEADING}>
              People cluster into constellations.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            <p className={BODY}>
              Companies, schools, old teams — Orbit draws your groups as
              figures in the sky, so the shape of your network is something
              you can actually see.
            </p>
          </Reveal>
        </div>
        <ConstellationFigure className="max-w-[520px] lg:justify-self-end" />
      </div>
    </section>
  );
}

export function SceneComets() {
  return (
    <section
      aria-labelledby="landing-reminders"
      className="landing-scene relative z-10 px-6 py-24 md:px-10"
    >
      <CometStreak />
      <div className="mx-auto w-full max-w-6xl">
        <div className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Reminders</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="landing-reminders" className={HEADING}>
              Never let a connection drift.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            <p className={BODY}>
              Give the people who matter a cadence. When someone goes quiet,
              Orbit streaks them back across your sky — a nudge before
              drifting becomes gone.
            </p>
          </Reveal>
        </div>
        <Reveal className="reveal-celestial" delay={240}>
          <div className="liquid-glass mt-10 max-w-sm rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0f3d3e] text-sm font-medium text-[#e8f3f1]">
                PR
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#e8f3f1]">
                  Priya Raman
                </p>
                <p className="text-xs text-[#9aada8]">
                  Quiet for 3 weeks · usually monthly
                </p>
              </div>
              <span className="ml-auto shrink-0 rounded-full bg-[#c4a35a]/15 px-2.5 py-1 text-xs text-[#c4a35a]">
                Nudge scheduled
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function SceneFinale({
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  return (
    <section
      aria-labelledby="landing-cta"
      className="landing-scene relative z-10 px-6 pt-24 md:px-10"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <Reveal className="reveal-celestial">
          <h2 id="landing-cta" className={HEADING}>
            Bring your universe into Orbit.
          </h2>
        </Reveal>
        <Reveal className="reveal-celestial" delay={100}>
          <p className={BODY}>
            Start with the people you already know — Orbit keeps them close.
          </p>
        </Reveal>
        <Reveal className="reveal-celestial" delay={200}>
          <div className="mt-8">
            <LandingAuthControls
              clerkOn={clerkOn}
              demoMode={demoMode}
              signedIn={signedIn}
              variant="hero"
            />
          </div>
        </Reveal>
      </div>

      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between pb-6 pt-24 md:pb-8">
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
      </footer>
    </section>
  );
}
