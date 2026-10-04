import {
  CalendarCheck,
  Check,
  Coins,
  Globe,
  Infinity as InfinityIcon,
  Megaphone,
  MessageCircle,
  Network,
  ScanText,
  Sparkles,
  UserSearch,
  Users,
  type LucideIcon,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { SubscriptionManager } from "@/components/settings/subscription-manager";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import { planCopy, unlimitedContactsLine } from "@/lib/plan-copy";
import type { Plan } from "@/lib/plan-limits";
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
 * near-black; as *text* (the ticks) it uses the theme-aware `--tier-*`, which clears 4.5:1.
 */
const PAID = {
  ring: "border-tier-border",
  wash: "bg-tier-surface",
  badge: "bg-gradient-to-b from-tier-sheen-from to-tier-sheen-to text-tier-sheen-ink shadow-sm",
  ink: "text-tier-accent",
  chip: "bg-tier-accent/15",
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
    /** Ticks and other accent marks. */
    ink: string;
    /** Tinted tile behind each feature's symbol. */
    chip: string;
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
    chip: "bg-muted",
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

/**
 * How one feature line is dressed here: a symbol, and the phrase to bold. Matched on the
 * shared copy from `plan-copy.ts` rather than stored beside it, because the marketing page
 * renders the same strings and has no use for either. A line nothing matches keeps the plain
 * tick and no bold, so new copy degrades to the old look instead of breaking.
 */
const FEATURE_STYLE: ReadonlyArray<{
  test: RegExp;
  icon: LucideIcon;
  bold: RegExp;
}> = [
  { test: /^Everything in/i, icon: Check, bold: /^Everything in the Free Plan/i },
  { test: /contacts/i, icon: Users, bold: /(Up to \d+|Unlimited) contacts/i },
  { test: /AI extraction/i, icon: ScanText, bold: /AI extraction/i },
  { test: /^Chat with/i, icon: MessageCircle, bold: /^Chat with your network/i },
  { test: /Constellation/i, icon: Network, bold: /Constellation map/i },
  { test: /LinkedIn/i, icon: Network, bold: /LinkedIn import/i },
  { test: /Reminders/i, icon: Check, bold: /Reminders and follow-up feed/i },
  { test: /Knowledge/i, icon: Check, bold: /Knowledge base/i },
  { test: /^Export/i, icon: Check, bold: /^Export your data/i },
  { test: /enrichment/i, icon: Coins, bold: /Contact enrichment/i },
  { test: /Outreach/i, icon: Megaphone, bold: /Outreach campaigns/i },
  { test: /Recruiter/i, icon: UserSearch, bold: /Recruiter tracking/i },
  { test: /Calendar/i, icon: CalendarCheck, bold: /Calendar links/i },
  { test: /Chrome/i, icon: Globe, bold: /Chrome extension/i },
];

function styleFeature(feature: string) {
  const match = FEATURE_STYLE.find((f) => f.test.test(feature));
  const icon: LucideIcon = /forever/i.test(feature) ? InfinityIcon : (match?.icon ?? Check);
  const bold = match ? feature.match(match.bold)?.[0] : undefined;
  return { icon, bold };
}

/** The feature's text with its key phrase bold and in the plan colour. */
function FeatureText({ feature, ink }: { feature: string; ink: string }) {
  const { bold } = styleFeature(feature);
  const at = bold ? feature.indexOf(bold) : -1;
  if (!bold || at < 0) return <span>{feature}</span>;
  return (
    <span>
      {feature.slice(0, at)}
      <strong className={cn("font-semibold", ink)}>{bold}</strong>
      {feature.slice(at + bold.length)}
    </span>
  );
}

export function PlanSettings({
  entitlements,
  usage,
  demoAccount,
}: {
  entitlements: Entitlements;
  usage: { used: number; limit: number | null; remaining: number | null };
  /** Set when plan limits are lifted because this is a demo account, not because of the plan. */
  demoAccount: DemoAccountReason | null;
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
            <h3 className="text-lg font-medium text-ink">Pricing Plan</h3>
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
            {unlimitedContactsLine(usage.used, demoAccount)}
          </p>
        )}

        {/* The card used to name the plan and say nothing about what it buys.
            Read from the same copy the pricing page renders, so the two cannot
            describe a tier differently. */}
        <div className="border-t border-border/60 pt-4">
          <h4 className="text-sm font-medium text-ink">
            What&apos;s included
          </h4>
          {/* Columns, not a two-column grid. A grid ties both cells of a row to
              the tallest of them, so a feature that wraps to two lines opened a
              double gap under its short neighbour. Columns flow independently,
              so every row sits the same distance from the last. */}
          <ul className="-mb-2.5 mt-3 sm:columns-2 sm:gap-x-6">
            {copy.features.map((feature) => {
              const { icon: Icon } = styleFeature(feature);
              return (
                <li
                  key={feature}
                  className="flex break-inside-avoid items-start gap-2.5 pb-2.5 text-sm text-ink"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-lg",
                      accent.chip,
                      accent.ink
                    )}
                  >
                    <Icon className="size-3.5" strokeWidth={2.25} />
                  </span>
                  <span className="pt-0.5">
                    <FeatureText feature={feature} ink={accent.ink} />
                  </span>
                </li>
              );
            })}
          </ul>
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
