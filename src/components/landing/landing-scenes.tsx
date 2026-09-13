import Link from "next/link";
import { CometStreak } from "@/components/landing/comet-streak";
import { ConstellationFigure } from "@/components/landing/constellation-figure";
import { FooterWordmark } from "@/components/landing/footer-wordmark";
import { GlassCard } from "@/components/landing/glass-card";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { Reveal } from "@/components/motion/reveal";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

// All narrative copy is server-rendered here so it ships in the document;
// <Reveal> only choreographs when it becomes visible.

export const KICKER = "text-xs uppercase tracking-[0.16em] text-[#f2c14e]";
export const HEADING =
  "mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]";
export const BODY = "mt-4 max-w-md text-base leading-relaxed text-[#9aada8] sm:text-lg";

export function SceneConstellations() {
  return (
    <section
      aria-labelledby="groups-heading"
      className="landing-scene scene-constellations relative z-10 flex min-h-[72svh] items-center px-8 py-20 md:min-h-[110svh] md:px-10 md:py-44"
    >
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
        <div id="groups">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Who you know, where</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="groups-heading" className={HEADING}>
              Every company on your list already has someone in it.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            {/* Names fade in as the figure draws; this paragraph still
             * carries the grouping payload for assistive tech. */}
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
      aria-labelledby="reminders-heading"
      className="landing-scene scene-comets relative z-10 px-8 py-24 md:px-10"
    >
      <CometStreak />
      <div className="mx-auto w-full max-w-6xl">
        <div id="reminders" className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>Before it goes cold</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2 id="reminders-heading" className={HEADING}>
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
          <GlassCard className="mt-10 max-w-sm rounded-2xl p-5">
            {/* Below md the pill drops to its own line: on a phone the name
             * block was squeezed to ~97px, wrapping the subtitle to three
             * lines beside a shrink-0 badge. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:flex-nowrap md:gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0f3d3e] text-sm font-medium text-[#e8f3f1]">
                PR
              </div>
              <div className="min-w-0 flex-1 md:flex-initial">
                <p className="text-sm font-medium text-[#e8f3f1]">
                  Priya Raman
                </p>
                <p className="text-xs text-[#9aada8]">
                  Referral call · 3 weeks ago · no follow-up sent
                </p>
              </div>
              <span className="ml-13 shrink-0 rounded-full bg-[#f2c14e]/15 px-2.5 py-1 text-xs text-[#f2c14e] md:ml-auto">
                Follow up today
              </span>
            </div>
          </GlassCard>
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
      id="cta"
      aria-labelledby="cta-heading"
      className="landing-scene scene-finale relative z-10 px-8 pt-24 md:px-10"
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
            <h2 id="cta-heading" className={HEADING}>
              Don&apos;t lose the person who gets you hired.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={100}>
            <p className={BODY}>
              Free for your first {FREE_CONTACT_LIMIT} contacts. Connect LinkedIn and Gmail once,
              and Orbit runs the follow-up loop while you keep interviewing.{" "}
              <Link
                href="/pricing"
                className="underline underline-offset-4 transition-opacity hover:opacity-80"
              >
                See pricing
              </Link>
              .
            </p>
          </Reveal>
          {/* w-full below sm so the stacked buttons fill the column — the
            * parent's items-center would otherwise size this to its content. */}
          <Reveal className="reveal-celestial w-full sm:w-auto" delay={200}>
            {/* Visible at every width — this is the page's closing ask, and
             * the hero's copy of these buttons is hidden below md. */}
            <div className="mt-8 w-full sm:w-auto">
              <LandingAuthControls
                clerkOn={clerkOn}
                demoMode={demoMode}
                signedIn={signedIn}
                variant="hero"
                mobileVisible
              />
            </div>
          </Reveal>
        </div>

        <Reveal
          className="reveal-celestial mx-auto w-full max-w-lg lg:mx-0 lg:justify-self-end"
          delay={160}
        >
          <GlassCard className="rounded-3xl p-6 text-left md:p-8">
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
              <WaitlistForm />
            </div>
            <p className="mt-3 text-xs text-[#6d807c]">
              No commitments. Interest list only.
            </p>
          </GlassCard>
        </Reveal>
      </div>

      <FinaleCloser clerkOn={clerkOn} demoMode={demoMode} signedIn={signedIn} />

      <div
        aria-hidden="true"
        className="relative z-10 mx-auto mt-24 h-px w-full max-w-4xl bg-[#e8f3f1]/[0.14]"
      />

      <MarketingFooter className="max-w-4xl">
        {/* Anchored on the footer's own box rather than offset from the
         * section above — a negative-offset sibling glow faded out before it
         * reached this text. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full md:h-[900px] md:w-[900px]"
          style={{
            background:
              "radial-gradient(circle, rgba(242,193,78,0.14), transparent 62%)",
          }}
        />
      </MarketingFooter>

      {/* Landing only: the other marketing pages end on the plain footer. Nothing may
       * follow it, since its bottom edge is the page's. */}
      <FooterWordmark className="relative z-10 mx-auto max-w-6xl" />
    </section>
  );
}

/**
 * The page's last word: the headline again, set as the largest type on the page
 * inside a still orbit ring, with one button under it.
 *
 * A <p>, not a heading. It repeats the h2 directly above it word for word, and
 * a second identical heading would read twice in a screen reader's outline.
 *
 * The questions sit in a native <details> so the ask stays uncluttered while the
 * answers ship in the document for anyone who opens them (and for search).
 * The button above creates a FREE account, so no answer may promise a Pro
 * feature as if it came with it. "Does Orbit email people for me? Yes" was cut
 * for exactly that: Gmail sync and sending are Pro (plan-copy.ts).
 */
function FinaleCloser({
  clerkOn,
  demoMode,
  signedIn,
}: {
  clerkOn: boolean;
  demoMode: boolean;
  signedIn: boolean;
}) {
  return (
    <div className="relative mx-auto mt-32 flex w-full max-w-4xl flex-col items-center text-center md:mt-40">
      <Reveal className="reveal-celestial relative isolate">
        {/* Stretched to the headline's box rather than drawn at a fixed aspect,
          * so it frames three lines on a phone and two on a desktop alike.
          * non-scaling-stroke keeps the line 1px however far it stretches. The
          * inset stays under the section's px-8, so it never widens the page. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-[6%] -inset-y-[38%] -z-10"
        >
          <svg
            className="size-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <ellipse
              cx="50"
              cy="50"
              rx="49"
              ry="46"
              fill="none"
              stroke="rgba(242,193,78,0.22)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <ellipse
              cx="50"
              cy="50"
              rx="38"
              ry="33"
              fill="none"
              stroke="rgba(232,243,241,0.07)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* On the outer ring at 150deg: (50 + 49cos, 50 + 46sin) in percent. */}
          <span className="absolute left-[7.6%] top-[73%] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2c14e] shadow-[0_0_0_6px_rgba(242,193,78,0.14)]" />
        </div>
        <p className="font-[family-name:var(--font-display)] text-[clamp(36px,6.4vw,72px)] font-light leading-[1.06] tracking-[-0.03em] text-balance text-[#e8f3f1]">
          Don&apos;t lose the person who{" "}
          <em className="text-[#f2c14e]">gets you hired.</em>
        </p>
      </Reveal>

      <Reveal className="reveal-celestial w-full sm:w-auto" delay={120}>
        <div className="mt-12 w-full sm:w-auto md:mt-16">
          <LandingAuthControls
            clerkOn={clerkOn}
            demoMode={demoMode}
            signedIn={signedIn}
            variant="hero"
            mobileVisible
            primaryOnly
            primaryLabel="Create your free account"
          />
        </div>
      </Reveal>

      <Reveal className="reveal-celestial w-full" delay={200}>
        <details className="group mx-auto mt-14 w-full max-w-xl border-y border-[#e8f3f1]/[0.08] text-left">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm text-[#e8f3f1] transition-colors hover:text-white focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e] [&::-webkit-details-marker]:hidden">
            Before you connect anything
            <span
              aria-hidden="true"
              className="text-base text-[#f2c14e] transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
            >
              +
            </span>
          </summary>
          <dl className="grid gap-5 pb-6 pt-1">
            <div>
              <dt className="font-[family-name:var(--font-display)] text-base text-[#e8f3f1]">
                Do I need to type everyone in?
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">
                No. Upload LinkedIn&apos;s Connections.csv and your whole
                network arrives at once, one page per person. Add anyone else by
                hand, or from your notes.
              </dd>
            </div>
            <div>
              <dt className="font-[family-name:var(--font-display)] text-base text-[#e8f3f1]">
                What does it read?
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">
                Your Gmail, Google Contacts and calendar, so it can build a
                timeline for the people you actually talk to. Sending is a
                separate permission it uses only when you press send.{" "}
                <Link
                  href="/privacy"
                  className="underline underline-offset-4 transition-opacity hover:opacity-80"
                >
                  The full list is in the privacy policy
                </Link>
                .
              </dd>
            </div>
          </dl>
        </details>
      </Reveal>
    </div>
  );
}
