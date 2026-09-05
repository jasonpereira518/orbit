import type { Metadata } from "next";
import Link from "next/link";
import { MailOpen, Sparkles, Unplug } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { InterestForm } from "@/components/interest/interest-form";
import { OrbitRingsBackdrop } from "@/components/interest/orbit-rings-backdrop";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { BackControl } from "@/components/pricing/back-control";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Interest list — Orbit",
  description: `Occasional notes from the person building Orbit, only when there's real news. Orbit is already live and free for your first ${FREE_CONTACT_LIMIT} contacts.`,
};

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const FOOTER_LINK = "text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]";

const EXPECT = [
  {
    icon: MailOpen,
    title: "Written by a person",
    body: "Every note comes from Jason, the one person who builds Orbit. There's no drip sequence and no marketing calendar behind it.",
  },
  {
    icon: Sparkles,
    title: "Only when it's real",
    body: "A launch, a big change, something worth your minute. Quiet months stay quiet.",
  },
  {
    icon: Unplug,
    title: "Leave in one click",
    body: "Every email carries a one-click unsubscribe. You're off the list immediately, no confirmation screen.",
  },
];

const FAQ: readonly FaqItem[] = [
  {
    q: "How often will you email me?",
    a: "Rarely. A short hello when you join, one tip a few days later if you haven't signed up, and after that only when there's real news. Quiet months are quiet.",
  },
  {
    q: "Is this a waitlist?",
    a: `No. Orbit is already live and free for your first ${FREE_CONTACT_LIMIT} contacts. The list is for people who'd rather hear what's new than check back.`,
  },
  {
    q: "What happens to my address?",
    a: (
      <>
        It gets the notes above and nothing else — never shared or sold. The
        details are in the <Link href="/privacy">privacy policy</Link>.
      </>
    ),
  },
  {
    q: "How do I leave?",
    a: "Every email has a one-click unsubscribe link. You're off immediately; there's no confirmation screen.",
  },
];

/**
 * Static and shared by every visitor: the only server work is two synchronous env
 * reads, and who is signed in resolves in the browser (`LandingAuthControls`). The
 * form talks to `joinInterestList` directly, so nothing here needs a request.
 *
 * Not a warp journey destination (see `lib/warp/journeys.ts`), so no arrival beacon.
 */
export default function InterestPage() {
  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();
  const authProps = { clerkOn, demoMode };
  // Mirrors the destinations `LandingAuthControls` chooses for "Get Started".
  const signUpHref = clerkOn ? "/sign-up" : demoMode ? "/dashboard" : "/sign-in";

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it is
    // mounted, which is what stops a light strip appearing on overscroll. The starfield
    // renders position:fixed, so this root must stay free of transform/filter.
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield interactive />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 md:px-10">
        <div className="flex items-center gap-4">
          <BackControl />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            {/* Below sm the wordmark is what pushes the auth controls into
                wrapping — the logo alone still identifies the link. */}
            <span className="hidden font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1] sm:inline">
              Orbit
            </span>
          </Link>
        </div>
        <LandingAuthControls {...authProps} variant="header" />
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-24 md:px-10">
        <section className="pt-10 text-center md:pt-16">
          <Reveal className="reveal-celestial">
            <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
              Interest list
            </p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={60}>
            <h1 className={`${HEADING} mt-4 text-[clamp(32px,5vw,56px)]`}>
              {/* Fraunces' true italic, declared in the root layout — the word that
                  carries the idea is the word that leans. */}
              Stay in <em className="italic">orbit</em>.
            </h1>
          </Reveal>
          <Reveal className="reveal-celestial" delay={120}>
            <p className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-[#9aada8] sm:text-lg">
              An occasional note from the person building Orbit — when there&apos;s
              real news, and not otherwise. It isn&apos;t a waitlist: the app is
              already live. One click to leave, any time.
            </p>
          </Reveal>
        </section>

        <section
          id="interest-join"
          aria-labelledby="interest-join-heading"
          className="relative mt-12 scroll-mt-24 md:mt-16"
        >
          <h2 id="interest-join-heading" className="sr-only">
            Join the interest list
          </h2>
          <OrbitRingsBackdrop />
          <Reveal className="reveal-celestial mx-auto block max-w-xl" delay={170}>
            <InterestForm signUpHref={signUpHref} />
          </Reveal>
        </section>

        <Reveal className="reveal-celestial mt-20 block">
          <ul className="grid gap-6 sm:grid-cols-3">
            {EXPECT.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <Icon
                  className="mt-0.5 size-[18px] shrink-0 text-[#f2c14e]"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-sm font-medium text-[#e8f3f1]">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>

        <section
          className="mt-24 md:mt-32"
          aria-labelledby="interest-live"
        >
          <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.1fr)_auto] lg:gap-14">
            <div>
              <Reveal className="reveal-celestial">
                <h2 id="interest-live" className={`${HEADING} text-[clamp(26px,3.4vw,38px)]`}>
                  There&apos;s nothing to <em className="italic">wait</em> for.
                </h2>
              </Reveal>
              <Reveal className="reveal-celestial" delay={90}>
                <p className="mt-4 max-w-[48ch] text-base leading-relaxed text-[#9aada8]">
                  Orbit is live today and free for your first {FREE_CONTACT_LIMIT}{" "}
                  contacts. You don&apos;t have to connect LinkedIn or Gmail — add
                  five people by hand and see whether it earns a place in your week.
                </p>
              </Reveal>
            </div>
            {/* Visible on phones too, unlike the pricing page's hero copy of these
                buttons: this is the page's honest detour and needs a tap target. */}
            <Reveal className="reveal-celestial w-full lg:w-auto" delay={170}>
              <LandingAuthControls {...authProps} variant="hero" mobileVisible />
            </Reveal>
          </div>
        </section>

        <section className="mt-24 md:mt-32" aria-labelledby="interest-faq">
          <Reveal className="reveal-celestial">
            <h2
              id="interest-faq"
              className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}
            >
              Before you hand over an address.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <FaqList items={FAQ} />
          </Reveal>
        </section>

        <section className="relative mt-24 text-center md:mt-32">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)",
            }}
          />
          <Reveal className="reveal-celestial">
            <h2 className={`${HEADING} text-[clamp(28px,3.8vw,42px)]`}>
              One address. Occasional news.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-4 max-w-[42ch] text-base leading-relaxed text-[#9aada8]">
              If you scrolled this far, the box is a click away.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
            {/* Back up to the form, not on to sign-up: one ask per page. */}
            <a
              href="#interest-join"
              className="inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white"
            >
              Join the list
            </a>
          </Reveal>
        </section>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 py-12 md:px-10">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
            Orbit
          </span>
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/pricing" className={FOOTER_LINK}>
            Pricing
          </Link>
          <Link href="/interest" className={FOOTER_LINK}>
            Interest list
          </Link>
          <Link href="/privacy" className={FOOTER_LINK}>
            Privacy
          </Link>
          <Link href="/contact" className={FOOTER_LINK}>
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
    </div>
  );
}
