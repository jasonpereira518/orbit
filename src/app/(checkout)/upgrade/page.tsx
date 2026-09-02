import type { Metadata } from "next";
import Link from "next/link";
import { Eye, KeyRound, RotateCcw } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { WarpArrivalBeacon } from "@/components/warp/warp-arrival-beacon";
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
 * Assembly slots, one piece per slot, top to bottom: header 0, heading 1, billing toggle 2,
 * the two plan cards 3 and 4, trust row 5 — see `upgrade-transition.tsx` for the
 * choreography itself. The toggle and cards live in `UpgradePlanCards`, so the numbering is
 * split across two files; `UpgradeTransition`'s `maxOrder` must stay in step with the
 * highest slot used anywhere in the tree (currently the trust row's 5).
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
    // `landing-root` keeps the body deep-space on overscroll, exactly as
    // /pricing does. The starfield is the sky the time warp decelerates into:
    // the stage cross-fades to this exact image, so the handoff is invisible,
    // and /upgrade stops being the one black page in the marketing world.
    // Twinkle and shooting stars are Starfield's own; nothing here moves near
    // the payment form itself.
    <div className="landing-root relative min-h-screen overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />
      {/* Ends the time warp's cruise hold. Until this mounts the stage keeps
          the exposure running, which is what covers this page's session
          resolve and three awaited reads. No-op on a direct load. */}
      <WarpArrivalBeacon />
      <UpgradeTransition maxOrder={5}>
        <HeaderPanel
          order={0}
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

        {/* `relative z-10` is load-bearing, not decoration: the permanent
            <LandingStarfield /> is a position:fixed canvas painting an opaque
            gradient, so a static <main> would be painted straight over — a
            positioned z-auto element paints above non-positioned in-flow
            content whatever the DOM order. /pricing's <main> carries the same
            pair for the same reason. */}
        <main className="relative z-10 mx-auto w-full max-w-4xl px-6 pb-24 md:px-8">
          {/* Fades rather than flies on the way home: everything else on this
              page is a card or a band, but this is a line of type, and type
              carried off sideways reads as an object being removed. Dissolving
              into the star trails reads as the words giving way to the sky. */}
          <Panel order={1} exit="fade">
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
            <Panel order={5} className="mt-14 block">
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
