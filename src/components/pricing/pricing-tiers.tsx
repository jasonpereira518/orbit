"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ANNUAL_SAVING_PERCENT,
  PLAN_COPY,
  type BillingPeriod,
} from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";

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
}: {
  planId: Plan;
  currentPlan: Plan | null;
  signedIn: boolean;
  seatsLeft: number;
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
    // Deliberately not a disabled <button>: there is no action to attempt, and a dead
    // control reads as a broken product. A stated queue reads as scarcity.
    return (
      <div className="space-y-2">
        <p
          className={cn(
            base,
            "border border-dashed border-[#f2c14e]/35 text-[#f2c14e]"
          )}
        >
          Opens to the first {seatsLeft}
        </p>
        <p className="text-center text-xs text-[#6d807c]">
          Not on sale yet — it unlocks when checkout opens.
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

  return (
    <Link
      href={signedIn ? "/settings#settings-plan" : "/sign-up"}
      className={cn(
        base,
        "bg-[#eef7f4] text-[#0f2e28] hover:opacity-90"
      )}
    >
      {signedIn ? "Upgrade to Orbit Pro" : "Start free, upgrade anytime"}
    </Link>
  );
}

export function PricingTiers({
  currentPlan,
  signedIn,
  seatsLeft,
}: {
  currentPlan: Plan | null;
  signedIn: boolean;
  seatsLeft: number;
}) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");

  return (
    <div className="space-y-10">
      <BillingToggle period={period} onChange={setPeriod} />

      <div className="grid items-start gap-5 lg:grid-cols-3 lg:gap-6">
        {PLAN_COPY.map((plan) => {
          const featured = plan.id === "orbit";
          const price = plan.price[period];

          return (
            <section
              key={plan.id}
              aria-labelledby={`tier-${plan.id}`}
              className={cn(
                "relative flex h-full flex-col rounded-3xl border p-7 backdrop-blur-sm",
                // Glass earns its place here: the cards sit over a live starfield, so
                // the blur is what separates the text from moving points of light.
                featured
                  ? "border-[#f2c14e]/35 bg-[#070b18]/80 lg:-mt-4 lg:pb-9 lg:pt-9"
                  : "border-[#e8f3f1]/[0.10] bg-[#05070f]/60"
              )}
            >
              {featured && (
                <>
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/3 rounded-full"
                    style={{
                      background:
                        "radial-gradient(circle, rgba(242,193,78,0.18), transparent 68%)",
                    }}
                  />
                  <p className="absolute -top-3 left-7 rounded-full bg-[#f2c14e] px-3 py-1 text-xs font-medium text-[#241a00]">
                    Most popular
                  </p>
                </>
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
                  this page that must always be readable. The page's motion lives in the
                  section reveals and the toggle pill instead. */}
              <div className="mt-4 min-h-[4.25rem]">
                <div>
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-[family-name:var(--font-display)] text-[42px] leading-none tracking-tight text-[#e8f3f1]">
                      {price.amount}
                    </span>
                    <span className="text-sm text-[#9aada8]">
                      {price.cadence}
                    </span>
                  </p>
                  {price.footnote && (
                    <p className="mt-1.5 text-sm text-[#f2c14e]">
                      {price.footnote}
                    </p>
                  )}
                </div>
              </div>

              <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">
                {plan.tagline}
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-3 text-sm text-[#cfdcd8]">
                    <Check
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        featured ? "text-[#f2c14e]" : "text-[#6f8b84]"
                      )}
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
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
