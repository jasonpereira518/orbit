"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { getPricingViewer } from "@/actions/billing";
import Link from "next/link";
import { Check } from "lucide-react";
import { PlanPriceDisplay } from "@/components/pricing/plan-price";
import { SubscriptionCheckoutButton } from "@/components/pricing/subscription-checkout-button";
import { cn } from "@/lib/utils";
import { foundingPriceTerms, PUBLIC_PLAN_COPY } from "@/lib/plan-copy";
import { isPurchasablePlan, type Plan } from "@/lib/plans/plan-config";

/**
 * Where signed-out buyers land after creating the account they need to buy: back here,
 * with the cards fresh in mind, rather than into onboarding.
 */
const SIGN_UP_FROM_PRICING = "/sign-up?redirect_url=/pricing";

function TierCta({
  planId,
  currentPlan,
  signedIn,
  checkoutOpen,
}: {
  planId: Plan;
  currentPlan: Plan | null;
  signedIn: boolean;
  /** Stripe is configured, so checkout can actually complete. */
  checkoutOpen: boolean;
}) {
  const base =
    "flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-medium transition-opacity";

  if (currentPlan === planId) {
    return (
      <p className={cn(base, "border border-[#e8f3f1]/[0.14] text-[#9aada8]")}>
        Your current plan
      </p>
    );
  }

  if (planId === "free") {
    return (
      <Link
        href={signedIn ? "/dashboard" : SIGN_UP_FROM_PRICING}
        className={cn(base, "border border-[#e8f3f1]/[0.18] text-[#e8f3f1] hover:opacity-80")}
      >
        {signedIn ? "Go to your orbit" : "Start free"}
      </Link>
    );
  }

  if (!isPurchasablePlan(planId)) return null;

  if (!checkoutOpen) {
    // Deliberately not a disabled <button>: with no checkout to attempt, a dead control
    // reads as a broken product, while a stated wait reads as a date not yet reached.
    return (
      <p className={cn(base, "border border-dashed border-[#e8f3f1]/25 text-[#9aada8]")}>
        Not on sale yet
      </p>
    );
  }

  if (!signedIn) {
    // Checkout needs an account to attribute the purchase to.
    return (
      <Link href={SIGN_UP_FROM_PRICING} className={cn(base, "bg-[#eef7f4] text-[#0f2e28] hover:opacity-90")}>
        Start free, upgrade anytime
      </Link>
    );
  }

  if (currentPlan === "lifetime") {
    return (
      <p className={cn(base, "border border-[#e8f3f1]/[0.14] text-[#9aada8]")}>
        Included in your Lifetime plan
      </p>
    );
  }

  if (currentPlan === "orbit" || currentPlan === "max") {
    // One plan at a time: a subscriber switches tier in Settings, on Stripe's confirmation
    // page, never through a second checkout.
    return (
      <Link
        href="/settings#settings-plan"
        className={cn(base, "border border-[#e8f3f1]/[0.18] text-[#e8f3f1] hover:opacity-80")}
      >
        Switch in Settings
      </Link>
    );
  }

  return <SubscriptionCheckoutButton plan={planId} />;
}

/**
 * Each tier owns an accent: Free stays recessed (dimmer border, no glow, muted ticks), Pro
 * wears the Pro blue and Max the gold. No popularity badge — nothing measures it, and an
 * unbacked "Most popular" is exactly the kind of nudge the no-fake-urgency rule forbids.
 * (Colors move to the plan tokens in the colour pass.)
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
    badge: null,
    raised: true,
  },
  max: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80 hover:border-[#f2c14e]/75",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
    badge: null,
    raised: false,
  },
  lifetime: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80 hover:border-[#f2c14e]/75",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
    badge: null,
    raised: false,
  },
};

type TiersProps = {
  clerkOn: boolean;
  checkoutOpen: boolean;
};

/**
 * The page is static and shared, so "who is this", "what plan are they on" and "does a
 * founding price apply" resolve in the browser after Clerk loads. `useAuth()` throws outside
 * a <ClerkProvider>, which is mounted only when Clerk is configured, so the hook lives in a
 * child that only exists when Clerk does. Signed out, nobody ever sees a founding price.
 */
export function PricingTiers(props: TiersProps) {
  if (!props.clerkOn) {
    return <PricingTiersView {...props} signedIn={false} currentPlan={null} founding={false} />;
  }
  return <ClerkAwareTiers {...props} />;
}

function ClerkAwareTiers(props: TiersProps) {
  const auth = useAuth();
  const signedIn = auth.isSignedIn === true;
  const [viewer, setViewer] = useState<{ plan: Plan; founding: boolean } | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    getPricingViewer()
      .then((v) => {
        if (!cancelled) setViewer(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  return (
    <PricingTiersView
      {...props}
      signedIn={signedIn}
      currentPlan={viewer?.plan ?? null}
      founding={signedIn && viewer?.founding === true}
    />
  );
}

function PricingTiersView({
  checkoutOpen,
  signedIn,
  currentPlan,
  founding,
}: TiersProps & { signedIn: boolean; currentPlan: Plan | null; founding: boolean }) {
  return (
    <div className="space-y-10">
      <div className="grid items-start gap-5 lg:grid-cols-3 lg:gap-6">
        {PUBLIC_PLAN_COPY.map((plan) => {
          const accent = TIER_ACCENT[plan.id];
          const price = plan.price;

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

              {/* No entrance animation: a price must be readable in the first frame. */}
              <div className="mt-4 min-h-[4.25rem]">
                <PlanPriceDisplay price={price} />
                {/* Founding pricing: only for an eligible signed-in account, always with its
                    full terms, never struck through. */}
                {founding && isPurchasablePlan(plan.id) && (
                  <p className="mt-2 text-xs leading-relaxed text-[#cfdcd8]">
                    Your founding price: {foundingPriceTerms(plan.id)}.
                  </p>
                )}
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
                  checkoutOpen={checkoutOpen}
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
