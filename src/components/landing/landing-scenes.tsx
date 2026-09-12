import Link from "next/link";
import { CometStreak } from "@/components/landing/comet-streak";
import { ConstellationFigure } from "@/components/landing/constellation-figure";
import { GlassCard } from "@/components/landing/glass-card";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { Reveal } from "@/components/motion/reveal";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
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
      {/* One ask, answered — not two offers side by side. The interest list used
       * to sit in a glass card of its own next to these buttons, which made the
       * secondary path the heavier object on the page. It is now a single line
       * below the questions. */}
      <div className="mx-auto flex w-full max-w-3xl -translate-y-4 flex-col items-center text-center md:-translate-y-6">
        <Reveal className="reveal-celestial">
          <h2 id="cta-heading" className={HEADING}>
            Don&apos;t lose the person who gets you hired.
          </h2>
        </Reveal>
        <Reveal className="reveal-celestial" delay={100}>
          <p className={`${BODY} mx-auto`}>
            Connect LinkedIn and Gmail once, and Orbit runs the follow-up loop
            while you keep interviewing.
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
        {/* The price, in view at the moment of the decision. It used to be a
          * clause mid-paragraph with the number behind a link, which put a
          * navigation between the visitor and the one fact they weigh.
          * Amounts come from plan-limits/plan-copy so this line cannot drift
          * from the pricing page or from what Stripe actually charges. */}
        <Reveal className="reveal-celestial" delay={260}>
          <p className="mt-5 text-sm text-[#9aada8]">
            Free for your first {FREE_CONTACT_LIMIT} contacts, then $
            {MONTHLY_AMOUNT} a month.{" "}
            <Link
              href="/pricing"
              className="underline underline-offset-4 transition-opacity hover:opacity-80"
            >
              See pricing
            </Link>
          </p>
        </Reveal>
      </div>

      {/* The objections that actually stop someone connecting an inbox, answered
       * before the ask rather than in a policy page nobody opens. Every claim
       * here is load-bearing: keep it in step with what the product does. */}
      <div className="mx-auto mt-20 w-full max-w-4xl">
        <Reveal className="reveal-celestial">
          <p className={`${KICKER} text-center`}>Before you connect anything</p>
        </Reveal>
        <dl className="mt-8 grid gap-8 text-left md:grid-cols-2 md:gap-12">
          <Reveal className="reveal-celestial" delay={80}>
            <dt className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">
              Does Orbit email people for me?
            </dt>
            {/* Verified against the send path: drafts are generated, you edit
              * and choose recipients, and only then does a send happen. No cron
              * job and no route handler sends mail. */}
            <dd className="mt-2 text-sm leading-relaxed text-[#9aada8]">
              Yes — from your own Gmail, and only after you have read it. Orbit
              writes the draft and queues it; you edit it, choose who it goes
              to, and press send. Nothing leaves your account on a schedule or
              without you.
            </dd>
          </Reveal>
          <Reveal className="reveal-celestial" delay={160}>
            <dt className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">
              What does it read?
            </dt>
            <dd className="mt-2 text-sm leading-relaxed text-[#9aada8]">
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
          </Reveal>
        </dl>
      </div>

      {/* Secondary path, and now weighted like one. The app is live, so this is
       * a mailing list — not a waitlist — and must not compete with the CTA. */}
      <Reveal className="reveal-celestial" delay={120}>
        <div className="mx-auto mt-16 w-full max-w-xl border-t border-[#e8f3f1]/[0.07] pt-8 text-center">
          <p className="text-sm text-[#9aada8]">
            Not ready to sign up? Get the occasional note on what&apos;s new in
            Orbit.
          </p>
          <div className="mx-auto mt-4 max-w-md">
            <WaitlistForm variant="inline" />
          </div>
        </div>
      </Reveal>

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
    </section>
  );
}
