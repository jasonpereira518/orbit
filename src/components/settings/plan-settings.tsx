import {
  Bell,
  BookOpen,
  CalendarCheck,
  Check,
  Code,
  Coins,
  Link2,
  Mic,
  Network,
  Plug,
  Sparkles,
  UserSearch,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CreditsUsage } from "@/components/credits/credits-card";
import { SubscriptionManager } from "@/components/settings/subscription-manager";
import {
  formatMinutes,
  type SpeechAllowanceView,
  type SpeechAllowances,
} from "@/components/settings/speech-usage-card";
import { TileDetails, UsageTile } from "@/components/settings/usage-tile";
import { cn } from "@/lib/utils";
import { WarpLink } from "@/components/warp/warp-link";
import { formatAllowanceReset } from "@/lib/ai-access-copy";
import { planBase, planCopy, unlimitedContactsLine } from "@/lib/plan-copy";
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
 * near-black; as *text* (the bold feature words) it uses the theme-aware `--tier-*`, which
 * clears 4.5:1.
 */
const PAID = {
  ring: "border-tier-border",
  wash: "bg-tier-surface",
  badge: "bg-gradient-to-b from-tier-sheen-from to-tier-sheen-to text-tier-sheen-ink shadow-sm",
  ink: "text-tier-accent",
  chip: "bg-tier-accent/15",
  meter: "bg-tier-accent",
  meterSoft: "bg-tier-accent/45",
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
    /** Tinted tile behind each feature's symbol. */
    chip: string;
    /** Usage meter fill. */
    meter: string;
    /** The second fill on a split meter (voice: short-form after meetings). */
    meterSoft: string;
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
    meterSoft: "bg-muted-foreground/35",
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
 * shared copy from `plan-copy.ts` rather than stored beside it, because the pricing page
 * renders the same strings and has no use for either. A line nothing matches keeps the plain
 * tick and no bold, so new copy degrades to the plain look instead of breaking.
 *
 * `key` also says what a line is about, so the inherited list can drop a base plan's line
 * that this plan restates with its own number (Pro's 300 credits under Max's 650).
 */
const FEATURE_STYLE: ReadonlyArray<{ key: string; test: RegExp; icon: LucideIcon; bold: RegExp }> = [
  { key: "everything", test: /^Everything in/i, icon: Check, bold: /^Everything in [^,]+/i },
  { key: "contacts", test: /contacts/i, icon: Users, bold: /(Up to [\d,]+|Unlimited) contacts/i },
  { key: "packs", test: /packs/i, icon: Coins, bold: /\$\d+ packs/i },
  { key: "ai", test: /AI (credits|included)/i, icon: Sparkles, bold: /[\d,]+ (AI )?credits/i },
  { key: "meetings", test: /meeting transcription/i, icon: Video, bold: /[\d.]+ (hours|minutes) of meeting transcription/i },
  { key: "voice", test: /voice notes/i, icon: Mic, bold: /[\d.]+ (hours|minutes) of voice notes/i },
  { key: "map", test: /Constellation/i, icon: Network, bold: /Constellation map/i },
  { key: "reminders", test: /Reminders/i, icon: Bell, bold: /Reminders/i },
  { key: "knowledge", test: /Knowledge/i, icon: BookOpen, bold: /Knowledge base/i },
  { key: "linkedin", test: /LinkedIn/i, icon: Network, bold: /LinkedIn import/i },
  { key: "connector", test: /Claude and ChatGPT/i, icon: Plug, bold: /Claude and ChatGPT/i },
  { key: "accounts", test: /Google|Microsoft/i, icon: Link2, bold: /Google and Microsoft|Google or Microsoft/i },
  { key: "recruiters", test: /Recruiter/i, icon: UserSearch, bold: /Recruiter tracking/i },
  { key: "calendar", test: /Calendar/i, icon: CalendarCheck, bold: /Calendar \w+/i },
  { key: "api", test: /REST API/i, icon: Code, bold: /REST API/i },
];

const styleOf = (feature: string) => FEATURE_STYLE.find((f) => f.test.test(feature));

/** The feature's text with its key phrase bold and in the plan colour. */
function FeatureText({ feature, ink }: { feature: string; ink: string }) {
  const bold = styleOf(feature)?.bold.exec(feature)?.[0];
  const at = bold ? feature.indexOf(bold) : -1;
  if (!bold || at < 0) return <span>{feature}</span>;
  return (
    <span>
      {feature.slice(0, at)}
      <strong className={cn("font-medium", ink)}>{bold}</strong>
      {feature.slice(at + bold.length)}
    </span>
  );
}

function FeatureList({
  features,
  accent,
  compact,
}: {
  features: string[];
  accent: (typeof TIER_ACCENT)[Plan];
  compact?: boolean;
}) {
  return (
    // Columns, not a two-column grid: a grid ties both cells of a row to the taller one, so a
    // feature that wraps opened a gap under its short neighbour. Columns flow independently.
    <ul className="-mb-2.5 sm:columns-2 sm:gap-x-6">
      {features.map((feature) => {
        const Icon = styleOf(feature)?.icon ?? Check;
        return (
          <li
            key={feature}
            className={cn(
              "flex break-inside-avoid items-start gap-2.5 pb-2.5 text-muted-foreground",
              compact ? "text-xs" : "text-sm"
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex shrink-0 items-center justify-center rounded-lg",
                compact ? "size-4" : cn("size-6", accent.chip),
                accent.ink
              )}
            >
              <Icon className={compact ? "size-3" : "size-3.5"} strokeWidth={2.25} />
            </span>
            <span className={compact ? undefined : "pt-0.5"}>
              {compact ? feature : <FeatureText feature={feature} ink={accent.ink} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

/** One kind of voice allowance in the tile's footnote: what's left, red when it's out. */
function VoiceKind({ label, allowance }: { label: string; allowance: SpeechAllowanceView }) {
  return (
    <span className={allowance.exhausted ? "text-destructive" : undefined}>
      {label} {formatMinutes(allowance.remaining)}
    </span>
  );
}

/**
 * Your plan and everything it meters, in one place: contacts, AI credits and voice minutes,
 * then what the plan includes — read from the same copy the pricing page renders, so the two
 * can't describe a plan differently.
 */
export function PlanSettings({
  entitlements,
  usage,
  demoAccount,
  config,
  speech,
}: {
  /** The effective plan table, so the name, tagline and benefits follow an admin's plan rules. */
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

  // No contact cap: the count rides in the benefits list instead of a meter of its own.
  const unlimited = usage.limit === null;
  const features = unlimited
    ? [unlimitedContactsLine(usage.used, demoAccount), ...copy.features.filter((f) => styleOf(f)?.key !== "contacts")]
    : copy.features;

  // What the plan builds on, minus anything this plan restates with its own number.
  const base = planBase(entitlements.plan);
  const covered = new Set<string | undefined>(
    features.map((f) => styleOf(f)?.key).filter((k) => k && k !== "everything")
  );
  if (unlimited) covered.add("contacts");
  const inherited = base
    ? planCopy(base, config).features.filter((f) => !covered.has(styleOf(f)?.key))
    : [];

  const { meeting, shortform, assistant } = speech;
  const cosmoLimit = Math.max(0, assistant?.limit ?? 0);
  const voiceLimit = Math.max(0, meeting.limit) + Math.max(0, shortform.limit) + cosmoLimit;
  const voiceLeft = Math.max(0, meeting.remaining) + Math.max(0, shortform.remaining) + Math.max(0, assistant?.remaining ?? 0);
  const voiceKinds = [
    meeting.limit > 0 && <VoiceKind key="m" label="Meetings" allowance={meeting} />,
    shortform.limit > 0 && <VoiceKind key="s" label="Notes" allowance={shortform} />,
    assistant && cosmoLimit > 0 && <VoiceKind key="c" label="Cosmo" allowance={assistant} />,
  ].filter(Boolean);

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
      <div className="relative space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-ink">Plan and usage</h3>
            <p className="mt-1 text-sm text-muted-foreground">{copy.tagline}</p>
            {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
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

        {/* Side by side: two tiles on a paid plan, three on Free (contacts are capped). */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] items-start gap-3">
          {usage.limit !== null && (
            <UsageTile
              label="Contacts"
              value={`${usage.used} / ${usage.limit}`}
              valueClassName={atLimit ? accent.ink : undefined}
              segments={[{ percent: pct(usage.used, usage.limit), className: accent.meter }]}
              foot={atLimit ? "Limit reached" : `${usage.limit - usage.used} more fit`}
            >
              {atLimit && (
                <p className="text-xs text-muted-foreground">
                  New contacts can&apos;t be added. Everything already in your orbit
                  stays exactly as it is.
                </p>
              )}
            </UsageTile>
          )}

          <CreditsUsage meterClassName={accent.meter} />

          {voiceLimit > 0 ? (
            <UsageTile
              label="Voice minutes"
              value={`${formatMinutes(voiceLeft)} left`}
              segments={[
                { percent: pct(Math.max(0, meeting.used), voiceLimit), className: accent.meter },
                { percent: pct(Math.max(0, shortform.used), voiceLimit), className: accent.meterSoft },
                ...(assistant ? [{ percent: pct(Math.max(0, assistant.used), voiceLimit), className: accent.meterSoft }] : []),
              ]}
              foot={`of ${formatMinutes(voiceLimit)} · resets ${formatAllowanceReset(meeting.limit > 0 ? meeting.resetsAt : shortform.resetsAt)}`}
            >
              {voiceKinds.length > 1 && (
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {voiceKinds}
                </p>
              )}
            </UsageTile>
          ) : (
            <UsageTile label="Voice minutes" value="Not on this plan" valueClassName="font-normal text-muted-foreground" />
          )}
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-ink">What&apos;s included</h4>
          <FeatureList features={features} accent={accent} />
          {base && inherited.length > 0 && (
            <div className="mt-3">
              <TileDetails label={`Show everything from ${planCopy(base, config).name}`}>
                <FeatureList features={inherited} accent={accent} compact />
              </TileDetails>
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
