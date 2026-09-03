"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { BillingToggle } from "@/components/pricing/billing-toggle";
import { LifetimeCheckoutButton } from "@/components/pricing/lifetime-checkout-button";
import { Panel } from "@/components/motion/upgrade-transition";
import { PlanPriceDisplay } from "@/components/pricing/plan-price";
import { ProCheckoutButton } from "@/components/pricing/pro-checkout-button";
import { planCopyWithOffer, type BillingPeriod, type PlanCopy } from "@/lib/plan-copy";
import { cn } from "@/lib/utils";

/**
 * Same accent language as the three-tier grid on /pricing (see `TIER_ACCENT` in
 * `pricing-tiers.tsx`), narrowed to the two plans actually sold here. Kept as its own copy
 * rather than imported: that map also carries Free's styling and the `raised`/hover-lift
 * behaviour a two-card confirm step doesn't use, so sharing it would drag unused shape
 * along for the one page that has no third card to react to.
 */
const ACCENT = {
  orbit: {
    surface: "border-brand-pro/40 bg-[#070b18]/80",
    tick: "text-brand-pro",
    glow: "radial-gradient(circle, rgba(89,157,231,0.20), transparent 68%)",
    badge: { label: "Most popular", className: "bg-brand-pro text-[#081326]" },
  },
  lifetime: {
    surface: "border-[#f2c14e]/40 bg-[#070b18]/80",
    tick: "text-[#f2c14e]",
    glow: "radial-gradient(circle, rgba(242,193,78,0.15), transparent 68%)",
    badge: { label: "Best value", className: "bg-[#f2c14e] text-[#241a00]" },
  },
} as const;

function PlanCard({
  plan,
  accent,
  footer,
}: {
  plan: PlanCopy;
  accent: (typeof ACCENT)[keyof typeof ACCENT];
  footer: ReactNode;
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
      <p
        className={cn(
          "absolute -top-3 left-6 rounded-full px-3 py-1 text-xs font-medium",
          accent.badge.className
        )}
      >
        {accent.badge.label}
      </p>

      <h2
        id={`upgrade-${plan.id}`}
        className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]"
      >
        {plan.name}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">{plan.tagline}</p>

      <div className="mt-4">
        <PlanPriceDisplay price={plan.price.monthly} />
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
  initialPeriod,
  hasPro,
  hasLifetime,
  proCheckoutConfigured,
  lifetimePurchasable,
  lifetimeOffer,
}: {
  initialPeriod: BillingPeriod;
  hasPro: boolean;
  hasLifetime: boolean;
  /** Stripe is configured for the Pro subscription price, so checkout can actually complete. */
  proCheckoutConfigured: boolean;
  /** Stripe is configured for the Lifetime price. */
  lifetimePurchasable: boolean;
  lifetimeOffer: { priceUsd: number; compareAtUsd: number | null };
}) {
  const [period, setPeriod] = useState<BillingPeriod>(initialPeriod);
  const plans = planCopyWithOffer(lifetimeOffer);
  const pro = plans.find((p) => p.id === "orbit")!;
  const lifetime = plans.find((p) => p.id === "lifetime")!;

  // Only the Pro price actually moves with the toggle — Lifetime is a flat one-time
  // amount — but both cards render through the same `PlanPriceDisplay`-driven `PlanCard`,
  // so Pro's copy is resolved to whichever period is selected before it gets there.
  const proForPeriod: PlanCopy = {
    ...pro,
    price: { monthly: pro.price[period], annual: pro.price[period] },
  };

  const showToggle = !hasPro && !hasLifetime;

  return (
    <div className="mt-12 space-y-8">
      {showToggle && (
        <Panel order={2} className="flex justify-center">
          <BillingToggle period={period} onChange={setPeriod} />
        </Panel>
      )}

      <div className="grid gap-5 md:grid-cols-2 md:gap-6">
        <Panel order={3} className="h-full">
          <PlanCard
            plan={proForPeriod}
            accent={ACCENT.orbit}
            footer={
              hasPro ? (
                <CardNotice>
                  This is your current plan. Manage or cancel it in{" "}
                  <Link href="/settings#settings-plan" className="text-[#e8f3f1] underline underline-offset-4">
                    Settings
                  </Link>
                  .
                </CardNotice>
              ) : hasLifetime ? (
                <CardNotice>
                  Already covered by Orbit Lifetime, minus contact enrichment on
                  Orbit&apos;s credits.
                </CardNotice>
              ) : proCheckoutConfigured ? (
                <ProCheckoutButton period={period} />
              ) : (
                <p className="rounded-xl border border-dashed border-[#e8f3f1]/[0.14] p-4 text-center text-sm text-[#9aada8]">
                  Subscription checkout is unavailable in this environment.
                </p>
              )
            }
          />
        </Panel>

        <Panel order={4} className="h-full">
          <PlanCard
            plan={lifetime}
            accent={ACCENT.lifetime}
            footer={
              hasLifetime ? (
                <CardNotice>Yours permanently. Nothing further to pay.</CardNotice>
              ) : lifetimePurchasable ? (
                <LifetimeCheckoutButton priceUsd={lifetimeOffer.priceUsd} />
              ) : (
                <p className="rounded-xl border border-dashed border-[#f2c14e]/35 px-4 py-3 text-center text-sm text-[#f2c14e]">
                  Not on sale yet
                </p>
              )
            }
          />
        </Panel>
      </div>
    </div>
  );
}
