import type { Metadata } from "next";
import Link from "next/link";
import { Eye, KeyRound, RotateCcw } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import {
  HeaderPanel,
  Panel,
  TransitionBackControl,
  UpgradeTransition,
} from "@/components/motion/upgrade-transition";
import { UpgradePlanCards } from "@/components/pricing/upgrade-plan-cards";
import { getLifetimeAvailability } from "@/actions/billing";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import { isProCheckoutConfigured } from "@/lib/stripe";

export const metadata: Metadata = {
  title: "Upgrade — Orbit",
  description: "Move to Orbit Pro, or buy Orbit Lifetime once.",
};

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

// Matches /pricing's trust row (see TRUST in pricing/page.tsx), placed right under the
// cards here rather than at the page floor — the point of hesitation, not past it.
const TRUST = [
  {
    icon: RotateCcw,
    title: "Cancel any time",
    body: "You keep Orbit Pro until the period you paid for ends, then drop back to the Free Plan.",
  },
  {
    icon: Eye,
    title: "Nothing is ever hidden",
    body: "Reaching a limit only stops new contacts. Everything already in your orbit stays visible and editable.",
  },
  {
    icon: KeyRound,
    title: "No markup on AI",
    body: "Every plan runs on your own provider key, billed to you at cost. We never resell tokens.",
  },
];

/**
 * Panel stagger slots, top to bottom: header and heading peel off to the left, the
 * billing toggle to the right, the two plan cards split apart from the same slot, and the
 * trust row closes it out to the right — see `upgrade-transition.tsx` for the choreography
 * itself. `UpgradeTransition`'s `maxOrder` below must stay in step with the highest slot
 * used here (currently the trust row's 4).
 */
export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  // Protected by proxy.ts, but resolved here too so the page never renders without a user
  // to attribute a purchase to.
  const userId = await requireUserId();
  const [entitlements, lifetime, offer, params] = await Promise.all([
    getEntitlements(userId),
    getLifetimeAvailability(),
    // The same resolution `/pricing` and `startLifetimeCheckout` use, so all three name
    // one price.
    lifetimeOffer(),
    searchParams,
  ]);

  const hasPro = entitlements.plan === "orbit";
  const hasLifetime = entitlements.plan === "lifetime";

  return (
    // `landing-root` keeps the body deep-space on overscroll, exactly as /pricing does.
    // No starfield here: a payment page should feel steady, and a moving background behind
    // a card form is friction dressed as delight.
    <div className="landing-root relative min-h-screen overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <UpgradeTransition maxOrder={4}>
        <HeaderPanel
          order={0}
          dir="left"
          className="relative z-10 mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-6 md:px-8"
        >
          <div className="flex items-center gap-4">
            <TransitionBackControl />
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
        </HeaderPanel>

        <main className="mx-auto w-full max-w-4xl px-6 pb-24 md:px-8">
          <Panel order={1} dir="left">
            <h1 className={`${HEADING} text-[clamp(28px,4vw,42px)]`}>
              {hasPro || hasLifetime
                ? "You're already on a paid plan."
                : "Pick how you'd like to pay."}
            </h1>
          </Panel>

          <UpgradePlanCards
            initialPeriod={params.period === "annual" ? "annual" : "monthly"}
            hasPro={hasPro}
            hasLifetime={hasLifetime}
            proCheckoutConfigured={isProCheckoutConfigured()}
            lifetimePurchasable={lifetime.purchasable}
            lifetimeOffer={{
              priceUsd: offer.priceUsd,
              compareAtUsd: offer.compareAtUsd,
            }}
          />

          {!hasPro && !hasLifetime && (
            <Panel order={4} dir="right" className="mt-14 block">
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
            </Panel>
          )}
        </main>
      </UpgradeTransition>
    </div>
  );
}
