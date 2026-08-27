import { Check, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import { planCopy } from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";
import type { Entitlements, PlanSource } from "@/lib/entitlements";

const SOURCE_NOTE: Record<PlanSource, string | null> = {
  comp: "Granted to you directly — no billing attached.",
  lifetime: "One-time purchase. Yours permanently.",
  subscription: null,
  free: null,
};

/**
 * The same tier identities the pricing page paints — Orbit Pro in the colour the
 * product itself runs on, Orbit Lifetime in the gold the marketing site reserves
 * for offers, Free deliberately recessed — restated for app chrome.
 *
 * The pricing page can hardcode `#599de7` and `#f2c14e` because it only ever sits
 * on a dark starfield. This card sits on `--card` in either theme, which splits
 * the gold in two: as a *surface* it can be the real brand gold, because the text
 * riding on it is near-black; as *text* on a white card it cannot, since `#f2c14e`
 * is 1.8:1 there. So the badge carries the bright metal and the ticks carry a
 * deeper amber that still clears 4.5:1.
 */
const TIER_ACCENT: Record<
  Plan,
  {
    /** Card border. */
    ring: string;
    /** Soft wash bled in from the top-right corner. */
    wash: string | null;
    /** Filled pill carrying the plan name. */
    badge: string;
    /** Ticks and other accent marks. */
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
  orbit: {
    // A dedicated blue rather than `--primary`: primary is teal in the light
    // theme, which is also the app's everyday chrome color (headings, links,
    // buttons) — a badge in that color didn't read as a distinct tier, just
    // as more of the same UI. `#599de7` matches the ring in orbit-logo.tsx
    // and the pricing page's Orbit Pro card, so "blue" means the same tier
    // everywhere.
    ring: "border-[#5b9de6]/40 dark:border-[#599de7]/45",
    wash: "bg-[#5b9de6]/15 dark:bg-[#599de7]/12",
    // Same vertical-ramp technique as Lifetime's gold: a light edge and a
    // shaded one for the glint to travel between.
    badge: "bg-gradient-to-b from-[#8ec4f5] to-[#5b9de6] text-[#0f2e4d] shadow-sm",
    ink: "text-[#2f68b0] dark:text-[#599de7]",
    meter: "bg-[#5b9de6] dark:bg-[#599de7]",
    glint: true,
  },
  lifetime: {
    ring: "border-[#e0a52e]/60 dark:border-[#f2c14e]/40",
    wash: "bg-[#f2c14e]/25 dark:bg-[#f2c14e]/15",
    // A vertical ramp rather than one flat fill: gold reads as metal only when
    // it has a light edge and a shaded one for the glint to travel between.
    badge:
      "bg-gradient-to-b from-[#f7d15f] to-[#e0a52e] text-[#3d2c00] shadow-sm",
    ink: "text-[#a06a00] dark:text-[#f2c14e]",
    meter: "bg-[#e0a52e] dark:bg-[#f2c14e]",
    glint: true,
  },
};

export function PlanSettings({
  entitlements,
  usage,
}: {
  entitlements: Entitlements;
  usage: { used: number; limit: number | null; remaining: number | null };
}) {
  const copy = planCopy(entitlements.plan);
  const note = SOURCE_NOTE[entitlements.source];
  const isFree = entitlements.plan === "free";
  const accent = TIER_ACCENT[entitlements.plan];

  // Only meaningful on a capped plan; an over-cap user (a lapsed subscriber) shows a full
  // bar rather than a negative remainder, and keeps full access to everything they have.
  const atLimit = usage.limit !== null && usage.used >= usage.limit;
  const pct =
    usage.limit === null ? 0 : Math.min(100, (usage.used / usage.limit) * 100);

  return (
    <section
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
            <h2 className="text-lg font-medium text-primary">Pricing Plan</h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.tagline}</p>
          </div>
          <span
            className={cn(
              "relative inline-flex shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-sm font-medium",
              accent.badge
            )}
          >
            {accent.glint && (
              <span
                aria-hidden="true"
                className="plan-badge-glint pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
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

        {usage.limit !== null ? (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Contacts</span>
              <span
                className={cn("tabular-nums", atLimit ? accent.ink : undefined)}
              >
                {usage.used} / {usage.limit}
              </span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={usage.used}
              aria-valuemin={0}
              aria-valuemax={usage.limit}
              aria-label="Contacts used"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width]",
                  accent.meter
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
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
            Unlimited contacts — {usage.used} in your orbit.
          </p>
        )}

        {/* The card used to name the plan and say nothing about what it buys.
            Read from the same copy the pricing page renders, so the two cannot
            describe a tier differently. */}
        <div className="border-t border-border/60 pt-4">
          <h3 className="text-sm font-medium text-primary">
            What&apos;s included
          </h3>
          {/* Columns, not a two-column grid. A grid ties both cells of a row to
              the tallest of them, so a feature that wraps to two lines opened a
              double gap under its short neighbour. Columns flow independently,
              so every row sits the same distance from the last. */}
          <ul className="-mb-2 mt-3 sm:columns-2 sm:gap-x-6">
            {copy.features.map((feature) => (
              <li
                key={feature}
                className="flex break-inside-avoid gap-2 pb-2 text-sm text-muted-foreground"
              >
                <Check
                  className={cn("mt-0.5 size-4 shrink-0", accent.ink)}
                  aria-hidden="true"
                />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        {!entitlements.canUseHostedEnrichment && entitlements.plan !== "free" && (
          <p className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
            Contact enrichment runs on your own Apollo key. Add it in the
            Outreach section below. Email and SMS sending is included on your
            plan.
          </p>
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
