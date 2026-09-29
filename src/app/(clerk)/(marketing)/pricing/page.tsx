import type { Metadata } from "next";
import Link from "next/link";
import { Eye, Sparkles, RotateCcw } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { BackControl } from "@/components/pricing/back-control";
import { WarpArrivalBeacon } from "@/components/warp/warp-arrival-beacon";
import { PlanComparison } from "@/components/pricing/plan-comparison";
import { PricingFaq } from "@/components/pricing/pricing-faq";
import { PricingTiers } from "@/components/pricing/pricing-tiers";
import { CreditExplainer } from "@/components/pricing/credit-explainer";
import { AI_POSITIONING } from "@/lib/plan-copy";
import { FREE_CONTACT_LIMIT, PLAN_CONFIG, formatPlanPrice } from "@/lib/plans/plan-config";
import { isCheckoutConfigured } from "@/lib/stripe-config";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

const PRO_PRICE = formatPlanPrice(PLAN_CONFIG.orbit.monthlyPriceCents ?? 0);
const MAX_PRICE = formatPlanPrice(PLAN_CONFIG.max.monthlyPriceCents ?? 0);

export const metadata: Metadata = {
  title: "Pricing — Orbit",
  description: `Orbit is free for your first ${FREE_CONTACT_LIMIT} contacts. Orbit Pro is ${PRO_PRICE} a month and Orbit Max ${MAX_PRICE} a month, both with AI included. ${AI_POSITIONING}`,
};

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const TRUST = [
  {
    icon: RotateCcw,
    title: "Cancel any time",
    body: "You keep your plan until the period you paid for ends, then drop back to the Free Plan.",
  },
  {
    icon: Eye,
    title: "Nothing is ever hidden",
    body: "Reaching a limit only stops new contacts. Everything already in your orbit stays visible and editable.",
  },
  {
    icon: Sparkles,
    title: "AI included, never auto-charged",
    body: "Pro and Max include AI credits each month. Run out and AI simply pauses until you choose a $5 pack or it resets — nothing is ever charged automatically.",
  },
];

/**
 * Static and shared by everyone: who is signed in, their plan, and whether a founding price
 * applies to them resolve in the browser (`LandingAuthControls`, `PricingTiers`).
 */
export default function PricingPage() {
  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();
  // Only offer checkout when Stripe can actually take the payment.
  const checkoutOpen = isCheckoutConfigured();
  const authProps = { clerkOn, demoMode };

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it is
    // mounted, which is what stops a light strip appearing on overscroll. The starfield
    // renders position:fixed, so this root must stay free of transform/filter.
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />
      {/* Ends the lift-off's cruise hold. Until this mounts the stage keeps the
          sky moving, which is what covers this page's auth() + two DB reads
          instead of flashing PricingPageSkeleton. No-op on a direct load. */}
      <WarpArrivalBeacon />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 md:px-10">
        <div className="flex items-center gap-4">
          <BackControl />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
              Orbit
            </span>
          </Link>
        </div>
        <LandingAuthControls {...authProps} variant="header" />
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-24 md:px-10">
        <section className="pt-10 text-center md:pt-16">
          <Reveal className="reveal-celestial">
            <h1 className={`${HEADING} text-[clamp(32px,5vw,56px)]`}>
              {/* Fraunces' true italic, declared in the root layout — the word that
                  carries the offer is the word that leans. */}
              <em className="italic">Free</em> for your first {FREE_CONTACT_LIMIT}{" "}
              contacts.
            </h1>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-[#9aada8] sm:text-lg">
              Bring your own AI key on the Free Plan. Orbit Pro and Orbit Max
              keep every contact, follow-up and warm intro in one place — with
              AI included.
            </p>
          </Reveal>
        </section>

        <Reveal className="reveal-celestial mt-14 block md:mt-20" delay={140}>
          <PricingTiers clerkOn={clerkOn} checkoutOpen={checkoutOpen} />
        </Reveal>

        <Reveal className="reveal-celestial mt-20 block">
          <ul className="grid gap-6 sm:grid-cols-3">
            {TRUST.map(({ icon: Icon, title, body }) => (
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

        <section className="mt-24 md:mt-32" aria-labelledby="pricing-compare">
          <Reveal className="reveal-celestial">
            <h2
              id="pricing-compare"
              className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}
            >
              Compare Plans
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 block" delay={80}>
            <PlanComparison />
          </Reveal>
        </section>

        <section className="mt-24 md:mt-32" aria-labelledby="pricing-credits">
          <Reveal className="reveal-celestial block">
            <CreditExplainer />
          </Reveal>
        </section>

        <section className="mt-24 md:mt-32" aria-labelledby="pricing-faq">
          <Reveal className="reveal-celestial">
            <h2
              id="pricing-faq"
              className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}
            >
              The things worth asking.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <PricingFaq />
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
              Start free. Decide later.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-4 max-w-[42ch] text-base leading-relaxed text-[#9aada8]">
              Bring in your connections, see the map, and find out whether Orbit
              earns a place in your week before you pay anything.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
            <LandingAuthControls {...authProps} variant="hero" />
          </Reveal>
        </section>
      </main>

      <MarketingFooter className="max-w-6xl px-6 md:px-10" />
    </div>
  );
}
