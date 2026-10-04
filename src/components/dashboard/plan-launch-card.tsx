import { ArrowUpRight, Infinity as InfinityIcon, Rocket, Sparkles } from "lucide-react";
import { DeepSpace } from "@/components/dashboard/deep-space";
import { WarpLink } from "@/components/warp/warp-link";
import { planCopy } from "@/lib/plan-copy";
import { FREE_CONTACT_LIMIT, PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";

/**
 * A porthole onto the destination.
 *
 * The card is painted in /pricing's own colours rather than the app's, so the
 * lift-off reads as going somewhere you could already see instead of the app
 * suddenly turning into a screensaver. That preview is the whole reason the
 * animation feels earned — take the deep-space panel away and the launch
 * becomes a non-sequitur.
 *
 * Paid plans get the same sky, restated as a certificate rather than an offer: no
 * pitch, no button that asks for money, just the tier's own colour — Pro blue, Max gold,
 * Lifetime silver — so holding the plan reads as having arrived somewhere.
 */
const PAID_TIER = {
  orbit: {
    Icon: Sparkles,
    /** Star and glow colour as `r,g,b` — fixed values, since the sky is the same in both themes. */
    rgb: "142,196,245",
    limb: "rgba(91,157,230,0.32), rgba(91,157,230,0.08) 55%",
    shadow: "hover:shadow-[0_0_48px_-12px_rgba(91,157,230,0.5)]",
  },
  max: {
    Icon: Sparkles,
    rgb: "242,193,78",
    limb: "rgba(242,193,78,0.30), rgba(242,193,78,0.08) 55%",
    shadow: "hover:shadow-[0_0_48px_-12px_rgba(242,193,78,0.45)]",
  },
  lifetime: {
    Icon: InfinityIcon,
    rgb: "197,204,214",
    limb: "rgba(197,204,214,0.26), rgba(197,204,214,0.07) 55%",
    shadow: "hover:shadow-[0_0_48px_-12px_rgba(197,204,214,0.4)]",
  },
} as const;

export function PlanLaunchCard({ plan }: { plan: Plan }) {
  if (plan !== "free") {
    const tier = PAID_TIER[plan];
    const name = PLAN_LABELS[plan];
    return (
      <WarpLink
        href="/pricing"
        data-plan={plan}
        className={`group relative block overflow-hidden rounded-2xl border border-tier-border bg-[#03050c] p-6 text-[#e8f3f1] transition-[border-color,box-shadow] duration-fast ease-house hover:border-tier-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tier-accent md:p-7 ${tier.shadow}`}
      >
        <DeepSpace accent={tier.rgb} />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 left-1/2 h-48 w-[140%] -translate-x-1/2 rounded-[50%] transition-transform duration-slow ease-house group-hover:-translate-y-2"
          style={{
            background: `radial-gradient(closest-side, ${tier.limb}, transparent 78%)`,
          }}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-5">
          <div className="min-w-0 max-w-md space-y-2">
            <span
              className={`relative inline-flex items-center gap-1.5 overflow-hidden rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide shadow-sm bg-gradient-to-b from-tier-sheen-from to-tier-sheen-to text-tier-sheen-ink`}
            >
              <span
                aria-hidden="true"
                className="plan-badge-glint pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
              />
              <tier.Icon className="relative size-3" aria-hidden="true" />
              <span className="relative">{name}</span>
            </span>
            <h2 className="font-[family-name:var(--font-display)] text-2xl leading-tight tracking-tight text-[#e8f3f1]">
              You&apos;re on <span className="text-tier-accent">{name}</span>.
            </h2>
            <p className="text-sm leading-relaxed text-[#9aada8]">{planCopy(plan).tagline}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-[#e8f3f1] transition-transform duration-fast ease-house group-hover:-translate-y-0.5">
            See all plans
            <ArrowUpRight
              className="size-4 transition-transform duration-fast ease-house group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </span>
        </div>
      </WarpLink>
    );
  }

  return (
    <WarpLink
      href="/pricing"
      className="group relative block overflow-hidden rounded-2xl border border-[#f2c14e]/25 bg-[#03050c] p-6 text-[#e8f3f1] transition-[border-color,box-shadow] duration-fast ease-house hover:border-[#f2c14e]/45 hover:shadow-[0_0_40px_-12px_rgba(242,193,78,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e] md:p-7"
    >
      <DeepSpace />
      {/* The limb of the planet you're about to leave. Lifts on hover. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 left-1/2 h-48 w-[140%] -translate-x-1/2 rounded-[50%] transition-transform duration-slow ease-house group-hover:-translate-y-2"
        style={{
          background:
            "radial-gradient(closest-side, rgba(242,193,78,0.28), rgba(242,193,78,0.08) 55%, transparent 78%)",
        }}
      />

      <div className="relative flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0 max-w-md space-y-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-night-free/30 bg-night-free/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-night-free">
            <Rocket className="size-3" aria-hidden="true" />
            Free plan
          </span>
          <h2 className="font-[family-name:var(--font-display)] text-2xl leading-tight tracking-tight text-[#e8f3f1]">
            Your first {FREE_CONTACT_LIMIT} contacts are on us.
          </h2>
          <p className="text-sm leading-relaxed text-[#9aada8]">
            Past that, Orbit Pro keeps every contact, follow-up, and warm intro
            in one place — with AI included.
          </p>
        </div>

        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#f2c14e] px-5 py-2.5 text-sm font-medium text-[#0a1024] shadow-[0_0_24px_-8px_rgba(242,193,78,0.8)] transition-transform duration-fast ease-house group-hover:-translate-y-0.5">
          Compare plans
          <ArrowUpRight
            className="size-4 transition-transform duration-fast ease-house group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </WarpLink>
  );
}
