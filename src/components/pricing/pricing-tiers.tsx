"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { getCurrentPlan } from "@/actions/billing";
import Link from "next/link";
import { Check } from "lucide-react";
import { BillingToggle } from "@/components/pricing/billing-toggle";
import { LifetimeCheckoutButton } from "@/components/pricing/lifetime-checkout-button";
import { PlanPriceDisplay } from "@/components/pricing/plan-price";
import { cn } from "@/lib/utils";
import { planCopyWithOffer, type BillingPeriod } from "@/lib/plan-copy";
import { type Plan } from "@/lib/plan-limits";

/**
 * Where signed-out buyers land after creating the account they need to buy: back here,
 * with the toggle and cards fresh in mind, rather than into onboarding.
 */
const SIGN_UP_FROM_PRICING = "/sign-up?redirect_url=/pricing";

function TierCta({
  planId,
  currentPlan,
  signedIn,
  lifetimePurchasable,
  lifetimePriceUsd,
  period,
}: {
  planId: Plan;
  currentPlan: Plan | null;
  signedIn: boolean;
  /** Stripe is configured, so checkout can actually complete. */
  lifetimePurchasable: boolean;
  lifetimePriceUsd: number;
  period: BillingPeriod;
}) {
  const base =
    "flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-medium transition-opacity";

  if (currentPlan === planId) {
    return (
      <p
        className={cn(
          base,
          "border border-[#e8f3f1]/[0.14] text-[#9aada8]"
        )}
      >
        Your current plan
      </p>
    );
  }

  if (planId === "lifetime") {
    if (!lifetimePurchasable) {
      // Deliberately not a disabled <button>: with no checkout to attempt, a dead control
      // reads as a broken product, while a stated wait reads as a date not yet reached.
      return (
        <div className="space-y-2">
          <p
            className={cn(
              base,
              "border border-dashed border-[#f2c14e]/35 text-[#f2c14e]"
            )}
          >
            Not on sale yet
          </p>
          <p className="text-center text-xs text-[#6d807c]">
            It unlocks when checkout opens.
          </p>
        </div>
      );
    }

    if (!signedIn) {
      // Checkout needs an account to attribute the purchase to, so send them to sign up
      // rather than into a Stripe session with nobody to grant the plan to.
      return (
        <Link
          href={SIGN_UP_FROM_PRICING}
          className={cn(
            base,
            "bg-[#f2c14e] font-medium text-[#241a00] hover:opacity-90"
          )}
        >
          Create an account to buy
        </Link>
      );
    }

    return <LifetimeCheckoutButton priceUsd={lifetimePriceUsd} />;
  }

  if (planId === "free") {
    return (
      <Link
        href={signedIn ? "/dashboard" : SIGN_UP_FROM_PRICING}
        className={cn(
          base,
          "border border-[#e8f3f1]/[0.18] text-[#e8f3f1] hover:opacity-80"
        )}
      >
        {signedIn ? "Go to your orbit" : "Start free"}
      </Link>
    );
  }

  // The chosen period rides along in the URL, and /upgrade's Orbit Pro section honours
  // it directly via ProCheckoutButton — real Stripe subscription checkout, not Clerk's
  // PricingTable, which had no way to preselect a period at all.
  const upgradeHref =
    period === "annual" ? "/upgrade?period=annual" : "/upgrade";

  return (
    <Link
      href={signedIn ? upgradeHref : SIGN_UP_FROM_PRICING}
      className={cn(
        base,
        "bg-[#eef7f4] text-[#0f2e28] hover:opacity-90"
      )}
    >
      {signedIn ? "Upgrade to Orbit Pro" : "Start free, upgrade anytime"}
    </Link>
  );
}

/**
 * Each tier owns an accent rather than a single `featured` boolean, because the two paid
 * tiers now say different things: Orbit Pro is the default path (Orbit's own primary blue,
 * centred and lifted on wide screens, badged "Most popular"), while Orbit Lifetime is the
 * value play (the gold accent the rest of the marketing site reserves for offers, badged
 * "Best Value"). The two badges carry two different messages in two different colours —
 * social proof against value — so neither dilutes the other.
 * Free stays deliberately recessed — dimmer border, no glow, muted ticks.
 */
const TIER_ACCENT: Record<
  Plan,
  {
    surface: string;
    tick: string;
    /** Soft wash behind the card's own translucent background. */
    glow: string | null;
    badge: { label: string; className: string } | null;
    /** The centre column reads as the recommendation through position alone. */
    raised: boolean;
  }
> = {
  free: {
    surface:
      "border-[#e8f3f1]/[0.10] bg-[#05070f]/60 hover:border-[#e8f3f1]/[0.22]",
    tick: "text-[#6f8b84]",
    glow: null,
    badge: null,
    raised: false,
  },
  orbit: {
    // `--brand-pro` is the Orbit Pro tier's own blue (see plan-badge.tsx), fixed
    // rather than theme-aware because this card only ever sits on the starfield.
    surface: "border-brand-pro/40 bg-[#070b18]/80 hover:border-brand-pro/75",
    tick: "text-brand-pro",
    glow: "radial-gradient(circle, rgba(89,157,231,0.20), transparent 68%)",
    badge: { label: "Most popular", className: "bg-brand-pro text-[#081326]" },
    raised: true,
  },
  lifetime: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80 hover:border-[#f2c14e]/75",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
    badge: { label: "Best Value", className: "bg-[#f2c14e] text-[#241a00]" },
    raised: false,
  },
};

type TiersProps = {
  clerkOn: boolean;
  lifetimePurchasable: boolean;
  /**
   * Resolved on the server from the live sale count, because Lifetime's price rises after
   * the introductory buyers. Passed in rather than read here so this stays a client
   * component; the shape is deliberately minimal for the same reason.
   */
  lifetimeOffer: { priceUsd: number; compareAtUsd: number | null };
};

/**
 * The page is static and shared, so "who is this" and "what plan are they on" resolve in
 * the browser after Clerk loads. `useAuth()` throws outside a <ClerkProvider>, which is
 * mounted only when Clerk is configured (also at build time, where this page is now
 * prerendered), so the hook lives in a child that only exists when Clerk does. Plan
 * awareness keys off a real Clerk user, never the demo user: without Clerk keys the header
 * renders signed-out, and crediting demo-user with a plan would put "Your current plan"
 * under a "Get Started" button.
 */
export function PricingTiers(props: TiersProps) {
  if (!props.clerkOn) return <PricingTiersView {...props} signedIn={false} currentPlan={null} />;
  return <ClerkAwareTiers {...props} />;
}

function ClerkAwareTiers(props: TiersProps) {
  const auth = useAuth();
  const signedIn = auth.isSignedIn === true;
  const [currentPlan, setCurrentPlan] = useState<Plan | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    getCurrentPlan()
      .then((plan) => {
        if (!cancelled) setCurrentPlan(plan);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  return <PricingTiersView {...props} signedIn={signedIn} currentPlan={currentPlan} />;
}

function PricingTiersView({
  lifetimePurchasable,
  lifetimeOffer,
  signedIn,
  currentPlan,
}: TiersProps & { signedIn: boolean; currentPlan: Plan | null }) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const plans = planCopyWithOffer(lifetimeOffer);

  return (
    <div className="space-y-10">
      <BillingToggle period={period} onChange={setPeriod} />

      <div className="grid items-start gap-5 lg:grid-cols-3 lg:gap-6">
        {plans.map((plan) => {
          const accent = TIER_ACCENT[plan.id];
          const price = plan.price[period];

          return (
            <section
              key={plan.id}
              aria-labelledby={`tier-${plan.id}`}
              className={cn(
                "relative flex h-full flex-col rounded-3xl border p-7 backdrop-blur-sm",
                // Glass earns its place here: the cards sit over a live starfield, so
                // the blur is what separates the text from moving points of light.
                accent.surface,
                // A short lift on hover, with the border brightening alongside it so the
                // movement reads as attention rather than drift. Tailwind v4 compiles
                // `-translate-y-*` to the `translate` property rather than `transform`, so
                // that is the property the transition has to name — `transform` would
                // compile fine and animate nothing.
                "transition-[translate,border-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-1.5",
                "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                accent.raised && "lg:-mt-4 lg:pb-9 lg:pt-9"
              )}
            >
              {accent.glow && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/3 rounded-full"
                  style={{ background: accent.glow }}
                />
              )}
              {accent.badge && (
                <p
                  className={cn(
                    "absolute -top-3 left-7 rounded-full px-3 py-1 text-xs font-medium",
                    accent.badge.className
                  )}
                >
                  {accent.badge.label}
                </p>
              )}

              <h2
                id={`tier-${plan.id}`}
                className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[#e8f3f1]"
              >
                {plan.name}
              </h2>

              {/* The price carries no entrance animation on purpose. Anything that starts
                  at opacity 0 and waits for a frame is invisible if frames never come —
                  a backgrounded tab, a throttled device — and a price is the one thing on
                  this page that must always be readable. PlanPriceDisplay honours that:
                  it stays static until the visitor toggles the period, and only then
                  animates the characters that genuinely changed. */}
              <div className="mt-4 min-h-[4.25rem]">
                <PlanPriceDisplay price={price} />
              </div>

              <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">
                {plan.tagline}
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-3 text-sm text-[#cfdcd8]">
                    <Check
                      className={cn("mt-0.5 size-4 shrink-0", accent.tick)}
                      aria-hidden="true"
                    />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              {plan.caveat && (
                <p className="mt-5 border-t border-[#e8f3f1]/[0.08] pt-4 text-xs leading-relaxed text-[#6d807c]">
                  {plan.caveat}
                </p>
              )}

              <div className="mt-6">
                <TierCta
                  planId={plan.id}
                  currentPlan={currentPlan}
                  signedIn={signedIn}
                  lifetimePurchasable={lifetimePurchasable}
                  lifetimePriceUsd={lifetimeOffer.priceUsd}
                  period={period}
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
