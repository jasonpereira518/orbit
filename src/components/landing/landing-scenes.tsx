import Link from "next/link";
import { CometStreak } from "@/components/landing/comet-streak";
import { ConstellationFigure } from "@/components/landing/constellation-figure";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { Reveal } from "@/components/motion/reveal";
import { OrbitLogo } from "@/components/orbit-logo";

// All narrative copy is server-rendered here so it ships in the document;
// <Reveal> only choreographs when it becomes visible.

export const KICKER = "text-xs uppercase tracking-[0.16em] text-[#f2c14e]";
export const HEADING =
  "mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]";
export const BODY = "mt-4 max-w-md text-base leading-relaxed text-[#9aada8] sm:text-lg";

export function SceneConstellations() {
  return (
    <section
      aria-labelledby="landing-groups-heading"
      className="landing-scene scene-constellations relative z-10 flex min-h-[90svh] items-center px-6 py-24 md:px-10"
    >
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
        <div id="landing-groups">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Who you know, where</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="landing-groups-heading" className={HEADING}>
              Every company on your list already has someone in it.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            {/* The figure's hover labels are aria-hidden and mouse-only, so
             * this paragraph is the sole carrier of the payload. */}
            <p className={BODY}>
              Orbit groups your contacts by employer, school, and old team — so
              the company at the top of your list stops being a cold
              application and starts being a warm intro.
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
      aria-labelledby="landing-reminders-heading"
      className="landing-scene scene-comets relative z-10 px-6 py-24 md:px-10"
    >
      <CometStreak />
      <div className="mx-auto w-full max-w-6xl">
        <div id="landing-reminders" className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Before it goes cold</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="landing-reminders-heading" className={HEADING}>
              That warm intro is already cooling.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            <p className={BODY}>
              Two weeks after a great call you are a stranger again. Orbit
              watches the gap and streaks the person back across your sky while
              the referral is still on the table.
            </p>
          </Reveal>
        </div>
        <Reveal className="reveal-celestial" delay={240}>
          {/* landing-glass, not liquid-glass: liquid-glass's light variant
           * has no `.dark` ancestor to invert against on this page, so it
           * rendered as a washed-out white panel instead of a card. */}
          <div className="landing-glass mt-10 max-w-sm rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0f3d3e] text-sm font-medium text-[#e8f3f1]">
                PR
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#e8f3f1]">
                  Priya Raman
                </p>
                <p className="text-xs text-[#9aada8]">
                  Referral call · 3 weeks ago · no follow-up sent
                </p>
              </div>
              <span className="ml-auto shrink-0 rounded-full bg-[#f2c14e]/15 px-2.5 py-1 text-xs text-[#f2c14e]">
                Follow up today
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
      id="landing-cta"
      aria-labelledby="landing-cta-heading"
      className="landing-scene scene-finale relative z-10 px-6 pt-24 md:px-10"
    >
      {/* Deep-space vignette: the base starfield stays put underneath, but
       * the last stretch of page (footer included) darkens toward it, so
       * reaching the bottom reads as descending further into space. Anchored
       * to a fixed pixel height off the bottom edge rather than a percentage
       * of the section — a percentage shrinks to nothing on short content,
       * which read as an abrupt cut instead of a gradual descent. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[640px] bg-[linear-gradient(to_bottom,transparent_0%,rgba(0,2,8,0.55)_55%,#00010a_100%)]"
      />
      <div className="mx-auto grid w-full max-w-5xl -translate-y-4 items-center gap-12 md:-translate-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <Reveal className="reveal-celestial">
            <h2 id="landing-cta-heading" className={HEADING}>
              Don&apos;t lose the person who gets you hired.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={100}>
            <p className={BODY}>
              Free to start. Connect LinkedIn and Gmail once, and Orbit runs the
              follow-up loop while you keep interviewing.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={200}>
            <div className="mt-8 hidden sm:block">
              <LandingAuthControls
                clerkOn={clerkOn}
                demoMode={demoMode}
                signedIn={signedIn}
                variant="hero"
              />
            </div>
          </Reveal>
        </div>

        <Reveal
          className="reveal-celestial mx-auto w-full max-w-lg lg:mx-0 lg:justify-self-end"
          delay={160}
        >
          <div className="landing-glass rounded-3xl p-6 text-left md:p-8">
            {/* Secondary path only. The app is live, so this is a mailing
             * list — not a waitlist — and must not compete with the CTA. */}
            <p className={KICKER}>Interest list</p>
            <p className="mt-2 text-lg text-[#e8f3f1]">
              Not ready to sign up?
            </p>
            <p className="mt-1 text-sm text-[#9aada8]">
              Get the occasional note on what&apos;s new in Orbit.
            </p>
            <div className="mt-4">
              <WaitlistForm clerkOn={clerkOn} demoMode={demoMode} />
            </div>
            <p className="mt-3 text-xs text-[#6d807c]">
              No commitments. Interest list only.
            </p>
          </div>
        </Reveal>
      </div>

      <div
        aria-hidden="true"
        className="relative z-10 mx-auto mt-24 h-px w-full max-w-4xl bg-[#e8f3f1]/[0.14]"
      />

      <footer className="relative z-10 mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-4 py-12">
        {/* Anchored on the footer's own box rather than offset from the
         * section above — a negative-offset sibling glow faded out before it
         * reached this text. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[900px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(242,193,78,0.14), transparent 62%)",
          }}
        />
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label="Orbit home"
        >
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
            Orbit
          </span>
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="/privacy"
            className="text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]"
          >
            Terms
          </Link>
          <Link
            href="/contact"
            className="text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]"
          >
            Contact
          </Link>
        </div>
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
