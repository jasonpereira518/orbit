"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import { LifetimeCheckoutButton } from "@/components/pricing/lifetime-checkout-button";
import { PlanPriceDisplay } from "@/components/pricing/plan-price";
import { cn } from "@/lib/utils";
import {
  ANNUAL_SAVING_PERCENT,
  PLAN_COPY,
  type BillingPeriod,
} from "@/lib/plan-copy";
import { LIFETIME_SEAT_LIMIT, type Plan } from "@/lib/plan-limits";

function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
}) {
  const name = useId();

  // Native radios inside a fieldset: arrow-key navigation, grouping, and the
  // checked state all come from the platform rather than from re-implemented ARIA.
  return (
    <fieldset className="mx-auto w-fit">
      <legend className="sr-only">Billing period</legend>
      <div className="flex items-center gap-1 rounded-full border border-[#e8f3f1]/[0.12] bg-[#05070f]/70 p-1 backdrop-blur-sm">
        {(["monthly", "annual"] as const).map((value) => {
          const selected = period === value;
          return (
            <label
              key={value}
              className={cn(
                "relative cursor-pointer rounded-full px-4 py-2 text-sm transition-colors",
                selected ? "text-[#0f2e28]" : "text-[#9aada8] hover:text-[#e8f3f1]",
                "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#f2c14e]"
              )}
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={selected}
                onChange={() => onChange(value)}
                className="sr-only"
              />
              {selected && (
                <motion.span
                  layoutId="pricing-period-pill"
                  className="absolute inset-0 -z-10 rounded-full bg-[#eef7f4]"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span className="relative whitespace-nowrap">
                {value === "monthly" ? "Monthly" : "Annual"}
                {value === "annual" && (
                  <span
                    className={cn(
                      "ml-1.5 text-xs",
                      selected ? "text-[#0f2e28]/70" : "text-[#f2c14e]"
                    )}
                  >
                    −{ANNUAL_SAVING_PERCENT}%
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function TierCta({
  planId,
  currentPlan,
  signedIn,
  seatsLeft,
  lifetimePurchasable,
  period,
}: {
  planId: Plan;
  currentPlan: Plan | null;
  signedIn: boolean;
  seatsLeft: number;
  /** Stripe is configured and seats remain, so checkout can actually complete. */
  lifetimePurchasable: boolean;
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
      // reads as a broken product, while a stated queue reads as scarcity.
      return (
        <div className="space-y-2">
          <p
            className={cn(
              base,
              "border border-dashed border-[#f2c14e]/35 text-[#f2c14e]"
            )}
          >
            {seatsLeft > 0 ? `Opens to the first ${seatsLeft}` : "Sold out"}
          </p>
          <p className="text-center text-xs text-[#6d807c]">
            {seatsLeft > 0
              ? "Not on sale yet — it unlocks when checkout opens."
              : "Every Orbit Lifetime spot has been claimed."}
          </p>
        </div>
      );
    }

    if (!signedIn) {
      // Checkout needs an account to attribute the purchase to, so send them to sign up
      // rather than into a Stripe session with nobody to grant the plan to.
      return (
        <div className="space-y-2">
          <Link
            href="/sign-up"
            className={cn(
              base,
              "bg-[#f2c14e] font-medium text-[#241a00] hover:opacity-90"
            )}
          >
            Create an account to claim
          </Link>
          <p className="text-center text-xs text-[#6d807c]">
            {seatsLeft} of {seatsLeft === 1 ? "1 spot" : "spots"} left.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <LifetimeCheckoutButton />
        <p className="text-center text-xs text-[#6d807c]">
          {seatsLeft} {seatsLeft === 1 ? "spot" : "spots"} left of{" "}
          {LIFETIME_SEAT_LIMIT}.
        </p>
      </div>
    );
  }

  if (planId === "free") {
    return (
      <Link
        href={signedIn ? "/dashboard" : "/sign-up"}
        className={cn(
          base,
          "border border-[#e8f3f1]/[0.18] text-[#e8f3f1] hover:opacity-80"
        )}
      >
        {signedIn ? "Go to your orbit" : "Start free"}
      </Link>
    );
  }

  // The chosen period rides along in the URL. Clerk's PricingTable has no prop to
  // preselect it, so /upgrade states it in copy rather than pretending it carried over.
  const upgradeHref =
    period === "annual" ? "/upgrade?period=annual" : "/upgrade";

  return (
    <Link
      href={signedIn ? upgradeHref : "/sign-up"}
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
 * centred and lifted on wide screens), while Orbit Lifetime is the value play (the gold
 * accent the rest of the marketing site reserves for offers, plus the only badge).
 * Free stays deliberately recessed — dimmer border, no glow, muted ticks.
 */
const TIER_ACCENT: Record<
  Plan,
  {
    surface: string;
    tick: string;
    /** Soft wash behind the card's own translucent background. */
    glow: string | null;
    badge: string | null;
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
    // #599de7 is `--primary` in the app's dark theme, so the plan that unlocks the
    // product is outlined in the colour the product itself runs on.
    surface: "border-[#599de7]/40 bg-[#070b18]/80 hover:border-[#599de7]/75",
    tick: "text-[#599de7]",
    glow: "radial-gradient(circle, rgba(89,157,231,0.20), transparent 68%)",
    badge: null,
    raised: true,
  },
  lifetime: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80 hover:border-[#f2c14e]/75",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
    badge: "Best Value",
    raised: false,
  },
};

export function PricingTiers({
  currentPlan,
  signedIn,
  seatsLeft,
  lifetimePurchasable,
}: {
  currentPlan: Plan | null;
  signedIn: boolean;
  seatsLeft: number;
  lifetimePurchasable: boolean;
}) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");

  return (
    <div className="space-y-10">
      <BillingToggle period={period} onChange={setPeriod} />

      <div className="grid items-start gap-5 lg:grid-cols-3 lg:gap-6">
        {PLAN_COPY.map((plan) => {
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
                <p className="absolute -top-3 left-7 rounded-full bg-[#f2c14e] px-3 py-1 text-xs font-medium text-[#241a00]">
                  {accent.badge}
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
                  seatsLeft={seatsLeft}
                  lifetimePurchasable={lifetimePurchasable}
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
