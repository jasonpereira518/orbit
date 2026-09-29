"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { Panel } from "@/components/motion/upgrade-transition";
import { PlanPriceDisplay } from "@/components/pricing/plan-price";
import { SubscriptionCheckoutButton } from "@/components/pricing/subscription-checkout-button";
import { foundingPriceTerms, planCopy, type PlanCopy } from "@/lib/plan-copy";
import type { Plan, PurchasablePlan } from "@/lib/plans/plan-config";
import { cn } from "@/lib/utils";

/**
 * Same accent language as the tier grid on /pricing (see `TIER_ACCENT` in
 * `pricing-tiers.tsx`), narrowed to the two plans actually sold here. No badges: nothing
 * measures popularity, so the page does not claim any.
 */
const ACCENT = {
  orbit: {
    surface: "border-brand-pro/40 bg-[#070b18]/80",
    tick: "text-brand-pro",
    glow: "radial-gradient(circle, rgba(89,157,231,0.20), transparent 68%)",
  },
  max: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
  },
} as const;

function PlanCard({
  plan,
  accent,
  footer,
  founding,
}: {
  plan: PlanCopy;
  accent: (typeof ACCENT)[keyof typeof ACCENT];
  footer: ReactNode;
  founding?: string | null;
}) {
  return (
    <section
      aria-labelledby={`upgrade-${plan.id}`}
      className={cn(
        "relative flex h-full flex-col rounded-3xl border p-6 backdrop-blur-sm",
        accent.surface
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/3 rounded-full"
        style={{ background: accent.glow }}
      />
      <h2
        id={`upgrade-${plan.id}`}
        className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]"
      >
        {plan.name}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">{plan.tagline}</p>

      <div className="mt-4">
        <PlanPriceDisplay price={plan.price} />
        {/* Founding pricing: eligible accounts only, always with the full terms. */}
        {founding && (
          <p className="mt-2 text-xs leading-relaxed text-[#cfdcd8]">Your founding price: {founding}.</p>
        )}
      </div>

      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2.5 text-sm text-[#cfdcd8]">
            <Check className={cn("mt-0.5 size-4 shrink-0", accent.tick)} aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {plan.caveat && (
        <p className="mt-4 border-t border-[#e8f3f1]/[0.08] pt-4 text-xs leading-relaxed text-[#6d807c]">
          {plan.caveat}
        </p>
      )}

      <div className="mt-5">{footer}</div>
    </section>
  );
}

/** A footer message for a card that isn't the one to act on right now (already owned, or covered by the other plan). */
function CardNotice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 rounded-xl border border-[#e8f3f1]/[0.10] bg-[#05070f]/50 p-4 text-sm text-[#9aada8]">
      <Check className="size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />
      {children}
    </p>
  );
}

export function UpgradePlanCards({
  currentPlan,
  founding,
  checkoutOpen,
}: {
  currentPlan: Plan;
  /** Whether this account's first subscription gets founding pricing. */
  founding: boolean;
  /** Stripe is configured, so checkout can actually complete. */
  checkoutOpen: boolean;
}) {
  const footerFor = (plan: PurchasablePlan): ReactNode => {
    if (currentPlan === plan) {
      return (
        <CardNotice>
          This is your current plan. Manage or cancel it in{" "}
          <Link href="/settings#settings-plan" className="text-[#e8f3f1] underline underline-offset-4">
            Settings
          </Link>
          .
        </CardNotice>
      );
    }
    if (currentPlan === "lifetime") {
      return <CardNotice>Your Lifetime plan already includes this, with AI on your own key.</CardNotice>;
    }
    if (currentPlan === "orbit" || currentPlan === "max") {
      return (
        <CardNotice>
          Switch between Pro and Max in{" "}
          <Link href="/settings#settings-plan" className="text-[#e8f3f1] underline underline-offset-4">
            Settings
          </Link>
          , where Stripe shows exactly what changes first.
        </CardNotice>
      );
    }
    if (!checkoutOpen) {
      return (
        <p className="rounded-xl border border-dashed border-[#e8f3f1]/[0.14] p-4 text-center text-sm text-[#9aada8]">
          Subscription checkout is unavailable in this environment.
        </p>
      );
    }
    return <SubscriptionCheckoutButton plan={plan} />;
  };

  return (
    <div className="mt-12 space-y-8">
      <div className="grid gap-5 md:grid-cols-2 md:gap-6">
        {(["orbit", "max"] as const).map((plan, index) => (
          <Panel key={plan} order={3 + index} className="h-full">
            <PlanCard
              plan={planCopy(plan)}
              accent={ACCENT[plan]}
              founding={founding && currentPlan === "free" ? foundingPriceTerms(plan) : null}
              footer={footerFor(plan)}
            />
          </Panel>
        ))}
      </div>
    </div>
  );
}
