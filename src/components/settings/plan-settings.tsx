import { Check, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CreditsUsage } from "@/components/credits/credits-card";
import { SubscriptionManager } from "@/components/settings/subscription-manager";
import {
  SpeechDetails,
  formatMinutes,
  speechTotals,
  type SpeechAllowances,
} from "@/components/settings/speech-usage-card";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import { planCopy, unlimitedContactsLine } from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";
import type { PlanConfig } from "@/lib/plans/plan-config";
import type { DemoAccountReason } from "@/lib/demo-account";
import type { Entitlements, PlanSource } from "@/lib/entitlements";

const SOURCE_NOTE: Record<PlanSource, string | null> = {
  comp: "Granted to you directly — no billing attached.",
  lifetime: "One-time purchase. Yours permanently.",
  subscription: null,
  free: null,
};

/**
 * The same plan identities the pricing page paints — Free deliberately recessed, Pro blue,
 * Max gold, Lifetime silver — restated for app chrome through the plan tokens.
 *
 * The pricing page uses the fixed "night" values because it only ever sits on a dark
 * starfield. This card sits on `--card` in either theme, so it splits each metal in two: as
 * a *surface* (the badge's sheen) it can be the bright metal, because the text on it is
 * near-black; as *text* it uses the theme-aware `--tier-*`, which clears 4.5:1.
 */
const PAID = {
  ring: "border-tier-border",
  wash: "bg-tier-surface",
  badge: "bg-gradient-to-b from-tier-sheen-from to-tier-sheen-to text-tier-sheen-ink shadow-sm",
  ink: "text-tier-accent",
  meter: "bg-tier-accent",
  glint: true,
};

const TIER_ACCENT: Record<
  Plan,
  {
    /** Card border. */
    ring: string;
    /** Soft wash bled in from the top-right corner. */
    wash: string | null;
    /** Filled pill carrying the plan name. */
    badge: string;
    /** Accent marks and an at-limit count. */
    ink: string;
    /** Usage meter fill. */
    meter: string;
    /** Whether the badge catches a travelling highlight. */
    glint: boolean;
  }
> = {
  free: {
    ring: "border-border/70",
    wash: null,
    badge: "border border-border/70 text-muted-foreground",
    ink: "text-muted-foreground",
    meter: "bg-muted-foreground/70",
    glint: false,
  },
  // Pro, Max and Lifetime share one shape; the `data-plan` on the card picks the colors
  // (Pro blue, Max gold, Lifetime silver — see the plan tokens in globals.css). The badge is
  // a vertical metallic ramp rather than a flat fill: a light edge and a shaded one for the
  // glint to travel between.
  orbit: PAID,
  max: PAID,
  lifetime: PAID,
};

/** One labelled bar, the shape every meter on this card shares. */
function Meter({
  label,
  value,
  percent,
  meterClassName,
  emphasis,
}: {
  label: string;
  value: string;
  percent: number;
  meterClassName: string;
  /** Tints the value: the meter is full. */
  emphasis?: string;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", emphasis)}>{value}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", meterClassName)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </>
  );
}

/**
 * Your plan and everything it meters, in one place: contacts, AI credits and voice minutes.
 * What each plan includes lives on the pricing page, one click away.
 */
export function PlanSettings({
  entitlements,
  usage,
  demoAccount,
  config,
  speech,
}: {
  /** The effective plan table, so the name and tagline follow an admin's plan rules. */
  config?: Record<Plan, PlanConfig>;
  entitlements: Entitlements;
  usage: { used: number; limit: number | null; remaining: number | null };
  /** Set when plan limits are lifted because this is a demo account, not because of the plan. */
  demoAccount: DemoAccountReason | null;
  /** Voice transcription this month — Orbit's own allowance, never the person's key. */
  speech: SpeechAllowances;
}) {
  const copy = planCopy(entitlements.plan, config);
  const note = SOURCE_NOTE[entitlements.source];
  const isFree = entitlements.plan === "free";
  const accent = TIER_ACCENT[entitlements.plan];

  // Only meaningful on a capped plan; an over-cap user (a lapsed subscriber) shows a full
  // bar rather than a negative remainder, and keeps full access to everything they have.
  const atLimit = usage.limit !== null && usage.used >= usage.limit;
  const pct =
    usage.limit === null ? 0 : Math.min(100, (usage.used / usage.limit) * 100);
  const voice = speechTotals(speech);

  return (
    <section
      data-plan={entitlements.plan}
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card p-6",
        accent.ring
      )}
    >
      {accent.wash && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl",
            accent.wash
          )}
        />
      )}

      {/* Positioned so it paints above the wash, which is itself positioned. */}
      <div className="relative space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-ink">Plan and usage</h3>
            <p className="mt-1 text-sm text-muted-foreground">{copy.tagline}</p>
          </div>
          <span
            className={cn(
              "relative inline-flex shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-sm font-medium",
              accent.badge
            )}
          >
            {/* Two sweeps, then it rests off-frame: an endless loop needs a pause control (SC 2.2.2). */}
            {accent.glint && (
              <span
                aria-hidden="true"
                className="plan-badge-glint pointer-events-none absolute [animation-iteration-count:2]! [animation-fill-mode:forwards]! inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
              />
            )}
            {/* Above the glint, which is positioned. */}
            {!isFree && (
              <Sparkles className="relative size-3.5" aria-hidden="true" />
            )}
            <span className="relative">{copy.name}</span>
          </span>
        </div>

        {note && <p className="text-sm text-muted-foreground">{note}</p>}

        <div className="space-y-5">
          {usage.limit !== null ? (
            <div className="space-y-2">
              <Meter
                label="Contacts"
                value={`${usage.used} / ${usage.limit}`}
                percent={pct}
                meterClassName={accent.meter}
                emphasis={atLimit ? accent.ink : undefined}
              />
              {atLimit && (
                <p className="text-sm text-muted-foreground">
                  You&apos;ve reached the limit, so new contacts can&apos;t be
                  added. Everything already in your orbit stays exactly as it is.
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className={cn("size-4", accent.ink)} aria-hidden="true" />
              {unlimitedContactsLine(usage.used, demoAccount)}
            </p>
          )}

          <CreditsUsage meterClassName={accent.meter} />

          {voice.limit > 0 ? (
            <div className="space-y-2">
              <Meter
                label="Voice minutes"
                value={`${formatMinutes(voice.used)} of ${formatMinutes(voice.limit)}`}
                percent={Math.min(100, (voice.used / voice.limit) * 100)}
                meterClassName={accent.meter}
              />
              <SpeechDetails speech={speech} />
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Voice minutes</span>
              <span className="text-muted-foreground">Not on this plan</span>
            </div>
          )}
        </div>

        {entitlements.source === "subscription" && (
          <div className="border-t border-border/60 pt-4">
            <h4 className="mb-3 text-sm font-medium text-ink">Your subscription</h4>
            <SubscriptionManager />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
          {isFree && (
            /* Points at the transaction page, not back at /pricing — that round
               trip was a loop with no way to actually pay at either end.
               Flies the chrono journey: a time warp forward to the orbit you
               would have without the ceiling. Only rendered for free users, so
               a paying customer is never shown a growth story they already
               bought. */
            <WarpLink
              href="/upgrade"
              journey="chrono"
              className={cn(buttonVariants({ size: "sm" }))}
            >
              Upgrade
            </WarpLink>
          )}
          <WarpLink
            href="/pricing"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            {isFree ? "Compare plans" : "See all plans"}
          </WarpLink>
        </div>
      </div>
    </section>
  );
}
