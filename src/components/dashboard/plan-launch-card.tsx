"use client";

import { ArrowUpRight, Rocket } from "lucide-react";
import { WarpLink } from "@/components/warp/warp-link";
import { FREE_CONTACT_LIMIT, type Plan } from "@/lib/plan-limits";

/**
 * A porthole onto the destination.
 *
 * The card is painted in /pricing's own colours rather than the app's, so the
 * lift-off reads as going somewhere you could already see instead of the app
 * suddenly turning into a screensaver. That preview is the whole reason the
 * animation feels earned — take the deep-space panel away and the launch
 * becomes a non-sequitur.
 *
 * Paid plans get a single quiet line instead: they have already bought the
 * thing, and a full-width upsell pointed at someone holding Lifetime is just
 * noise on their own dashboard.
 */
export function PlanLaunchCard({ plan }: { plan: Plan }) {
  if (plan !== "free") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/80 px-4 py-3 backdrop-blur">
        <p className="text-sm text-muted-foreground">
          You&apos;re on{" "}
          <span className="font-medium text-foreground">
            {plan === "lifetime" ? "Orbit Lifetime" : "Orbit Pro"}
          </span>
          . Everything below is unlimited.
        </p>
        <WarpLink
          href="/pricing"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          See all plans
          <ArrowUpRight className="size-3.5 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </WarpLink>
      </div>
    );
  }

  return (
    <WarpLink
      href="/pricing"
      className="group relative block overflow-hidden rounded-2xl border border-[#f2c14e]/25 bg-[#03050c] p-6 text-[#e8f3f1] transition-[border-color,box-shadow] duration-300 ease-out hover:border-[#f2c14e]/45 hover:shadow-[0_0_40px_-12px_rgba(242,193,78,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e] md:p-7"
    >
      {/* Deep-space base — the same gradient lib/sky-palette.ts paints, so the
          panel and the page you land on are literally the same sky. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 140% at 50% 20%, #0f1630 0%, #0a1024 42%, #060915 72%, #03050c 100%)",
        }}
      />
      {/* A handful of fixed stars. Static gradients rather than a canvas: this
          is decoration on a dashboard, not a set piece worth an rAF loop. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: [
            "radial-gradient(1.4px 1.4px at 12% 24%, rgba(232,243,241,0.9), transparent)",
            "radial-gradient(1px 1px at 27% 68%, rgba(232,243,241,0.55), transparent)",
            "radial-gradient(1.6px 1.6px at 44% 18%, rgba(242,193,78,0.85), transparent)",
            "radial-gradient(1px 1px at 61% 52%, rgba(232,243,241,0.5), transparent)",
            "radial-gradient(1.2px 1.2px at 74% 28%, rgba(232,243,241,0.75), transparent)",
            "radial-gradient(1px 1px at 88% 62%, rgba(232,243,241,0.45), transparent)",
            "radial-gradient(1.3px 1.3px at 36% 84%, rgba(232,243,241,0.6), transparent)",
            "radial-gradient(1px 1px at 92% 16%, rgba(242,193,78,0.6), transparent)",
          ].join(","),
        }}
      />
      {/* The limb of the planet you're about to leave. Lifts on hover. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 left-1/2 h-48 w-[140%] -translate-x-1/2 rounded-[50%] transition-transform duration-500 ease-out group-hover:-translate-y-2"
        style={{
          background:
            "radial-gradient(closest-side, rgba(242,193,78,0.28), rgba(242,193,78,0.08) 55%, transparent 78%)",
        }}
      />

      <div className="relative flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0 max-w-md space-y-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#f2c14e]/30 bg-[#f2c14e]/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[#f2c14e]">
            <Rocket className="size-3" aria-hidden="true" />
            Free plan
          </span>
          <h2 className="font-[family-name:var(--font-display)] text-2xl leading-tight tracking-tight text-[#e8f3f1]">
            Your first {FREE_CONTACT_LIMIT} contacts are on us.
          </h2>
          <p className="text-sm leading-relaxed text-[#9aada8]">
            Past that, five dollars a month keeps every contact, follow-up, and
            warm intro in one place — or pay once and keep it for good.
          </p>
        </div>

        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#f2c14e] px-5 py-2.5 text-sm font-medium text-[#0a1024] shadow-[0_0_24px_-8px_rgba(242,193,78,0.8)] transition-transform duration-300 ease-out group-hover:-translate-y-0.5">
          Compare plans
          <ArrowUpRight
            className="size-4 transition-transform duration-300 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </WarpLink>
  );
}
