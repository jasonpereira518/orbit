import type { Metadata } from "next";
import Link from "next/link";
import { Check, Eye, RotateCcw } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Reveal } from "@/components/motion/reveal";
import { BackControl } from "@/components/pricing/back-control";
import { LifetimeCheckoutButton } from "@/components/pricing/lifetime-checkout-button";
import { OrbitProCheckout } from "@/components/checkout/orbit-pro-checkout";
import { getLifetimeAvailability } from "@/actions/billing";
import { requireUserId } from "@/lib/auth";
import { getEntitlements, ORBIT_PLAN_SLUG } from "@/lib/entitlements";
import { planCopy } from "@/lib/plan-copy";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import {
  LIFETIME_INTRO_SEATS,
  LIFETIME_STANDARD_PRICE,
} from "@/lib/plan-limits";
import { isClerkConfigured } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Upgrade — Orbit",
  description: "Move to Orbit Pro, or buy Orbit Lifetime once.",
};

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

const ASSURANCES = [
  { icon: RotateCcw, text: "Cancel any time — you keep Orbit Pro until the period you paid for ends." },
  { icon: Eye, text: "Nothing is ever hidden. Reaching a limit only stops new contacts." },
];

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

  const wantsAnnual = params.period === "annual";
  const hasPro = entitlements.plan === "orbit";
  const hasLifetime = entitlements.plan === "lifetime";
  const annual = planCopy("orbit").price.annual;

  return (
    // `landing-root` keeps the body deep-space on overscroll, exactly as /pricing does.
    // No starfield here: a payment page should feel steady, and a moving background behind
    // a card form is friction dressed as delight.
    <div className="landing-root relative min-h-screen overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-6 md:px-8">
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
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-24 md:px-8">
        <Reveal className="reveal-celestial">
          <h1 className={`${HEADING} text-[clamp(28px,4vw,42px)]`}>
            {hasPro || hasLifetime
              ? "You're already on a paid plan."
              : "Pick how you'd like to pay."}
          </h1>
        </Reveal>

        {wantsAnnual && !hasPro && !hasLifetime && (
          <Reveal className="reveal-celestial" delay={70}>
            <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-[#9aada8]">
              You chose annual on the pricing page — {annual.amount}{" "}
              {annual.cadence}, {annual.footnote?.toLowerCase()}. Select{" "}
              <span className="text-[#e8f3f1]">Annual</span> below to get that
              rate; the table starts on monthly.
            </p>
          </Reveal>
        )}

        {/* ── Orbit Pro ── */}
        <section className="mt-12" aria-labelledby="upgrade-pro">
          <Reveal className="reveal-celestial">
            <h2 id="upgrade-pro" className={`${HEADING} text-xl`}>
              Orbit Pro
            </h2>
          </Reveal>

          <Reveal className="reveal-celestial mt-5 block" delay={60}>
            {hasPro ? (
              <p className="flex items-center gap-2.5 rounded-2xl border border-[#e8f3f1]/[0.10] bg-[#05070f]/60 p-5 text-sm text-[#9aada8]">
                <Check className="size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />
                This is your current plan. Manage or cancel it in{" "}
                <Link href="/settings#settings-plan" className="text-[#e8f3f1] underline underline-offset-4">
                  Settings
                </Link>
                .
              </p>
            ) : hasLifetime ? (
              <p className="rounded-2xl border border-[#e8f3f1]/[0.10] bg-[#05070f]/60 p-5 text-sm leading-relaxed text-[#9aada8]">
                Orbit Lifetime already covers everything Orbit Pro does, minus
                contact enrichment on Orbit&apos;s credits. Subscribing as well
                would only add that.
              </p>
            ) : isClerkConfigured() ? (
              <OrbitProCheckout highlightedPlan={ORBIT_PLAN_SLUG} />
            ) : (
              <p className="rounded-2xl border border-dashed border-[#e8f3f1]/[0.14] p-5 text-sm text-[#9aada8]">
                Subscription checkout is unavailable in this environment.
              </p>
            )}
          </Reveal>
        </section>

        {/* ── Orbit Lifetime ── */}
        <section className="mt-16" aria-labelledby="upgrade-lifetime">
          <Reveal className="reveal-celestial">
            <h2 id="upgrade-lifetime" className={`${HEADING} text-xl`}>
              Orbit Lifetime
            </h2>
          </Reveal>

          <Reveal className="reveal-celestial mt-5 block" delay={60}>
            <div className="rounded-2xl border border-[#f2c14e]/25 bg-[#070b18]/80 p-6">
              {hasLifetime ? (
                <p className="flex items-center gap-2.5 text-sm text-[#9aada8]">
                  <Check className="size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />
                  Yours permanently. Nothing further to pay.
                </p>
              ) : (
                <>
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-[family-name:var(--font-display)] text-[34px] leading-none tracking-tight text-[#e8f3f1]">
                      ${offer.priceUsd}
                    </span>
                    {/* Shown only while the introductory price is actually in effect. A
                        permanent "was $49" beside a price that is simply $25 is a fake
                        discount, not a design flourish. */}
                    {offer.compareAtUsd && (
                      <span className="text-base leading-none text-[#9aada8]/70 line-through decoration-[#9aada8]/60">
                        ${offer.compareAtUsd}
                      </span>
                    )}
                    <span className="text-sm text-[#9aada8]">once</span>
                  </p>
                  {offer.introRemaining !== null && (
                    <p className="mt-1.5 text-sm text-[#f2c14e]">
                      Introductory price for the first {LIFETIME_INTRO_SEATS} buyers, then
                      ${LIFETIME_STANDARD_PRICE}. Lifetime itself never sells out.
                    </p>
                  )}
                  <p className="mt-3 max-w-[58ch] text-sm leading-relaxed text-[#9aada8]">
                    Unlimited contacts, outreach with email and SMS sending,
                    recruiter tracking, mailbox and calendar sync, and the
                    extension — permanently. Contact enrichment runs on your own
                    Apollo key rather than Orbit&apos;s credits, which is what
                    keeps a one-time price honest.
                  </p>

                  <div className="mt-5">
                    {lifetime.purchasable ? (
                      <LifetimeCheckoutButton priceUsd={offer.priceUsd} />
                    ) : (
                      <p className="rounded-xl border border-dashed border-[#f2c14e]/35 px-4 py-3 text-center text-sm text-[#f2c14e]">
                        Not on sale yet
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </Reveal>
        </section>

        {!hasPro && !hasLifetime && (
          <Reveal className="reveal-celestial mt-12 block">
            <ul className="space-y-3">
              {ASSURANCES.map(({ icon: Icon, text }) => (
                <li key={text} className="flex gap-3 text-sm leading-relaxed text-[#9aada8]">
                  <Icon className="mt-0.5 size-4 shrink-0 text-[#f2c14e]" aria-hidden="true" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        )}
      </main>
    </div>
  );
}
