import { formatLastTouch } from "@/lib/relative-date";
import { ConstellationPinButton } from "@/components/contacts/constellation-pin-button";
import { HealthSparkline } from "@/components/contacts/health-sparkline";
import { StatPillExplainer } from "@/components/contacts/stat-pill-explainer";
import {
  CLOSENESS_TIER_LABEL,
  CLOSENESS_TIER_TONE,
} from "@/components/contacts/closeness-tone";
import { Badge } from "@/components/ui/badge";
import { TONE } from "@/lib/tone";
import type { ClosenessBreakdown } from "@/lib/closeness";
import type { RelationshipHealth } from "@/lib/relationship-health";

export function ContactStatPills({
  closeness,
  lastTouchAt,
  hasLoggedInteraction,
  health,
  constellation,
}: {
  closeness: ClosenessBreakdown;
  /** Null when there is no touch in the window to score — the pill is left out. */
  health?: RelationshipHealth | null;
  lastTouchAt: Date | string | null;
  /**
   * Whether an `interactions` row exists. `lastTouchAt` falls back to
   * `contacts.lastInteractionAt`, which is stamped on every create/import — so
   * without this, an untouched LinkedIn import claims a "last interaction" that never
   * happened, right next to a timeline that says "no interactions yet".
   */
  hasLoggedInteraction: boolean;
  /**
   * Omitted when the constellation filter is off globally — a control with no effect is
   * worse than no control. Any stored pin is preserved either way.
   */
  constellation?: {
    contactId: string;
    pin: "in" | "out" | null;
    substantive: boolean;
  };
}) {
  const pct = Math.round(closeness.closeness * 100);
  const since = lastTouchAt ? formatLastTouch(new Date(lastTouchAt)) : null;
  const lastLabel = !since
    ? "No interactions yet"
    : hasLoggedInteraction
      ? `Last interaction ${since}`
      : `In your contacts ${since}`;
  const tone = CLOSENESS_TIER_TONE[closeness.tier];

  return (
    // `items-center` so the constellation button sits on the same baseline as the badges —
    // it is a real button and slightly taller than they are.
    <div className="flex flex-wrap items-center gap-2">
      <StatPillExplainer
        label={`Closeness ${pct}%. Show what this means.`}
        className={TONE[tone].chip}
        title={`Closeness ${pct}% · how much they matter`}
        body={
          <>
            <p className="text-muted-foreground">
              Where this person sits in your network: your rating, how recently and how often
              you’re in touch, and how they fit your goals — ranked against everyone else
              you know.
            </p>
            <p className="border-t border-border-subtle pt-2 text-muted-foreground">
              {health
                ? "Health, next to it, is how the conversation itself is going: reply speed, who writes, and recency."
                : "It doesn’t look at who writes or how fast replies come — that’s Health, once there are touches to score."}
            </p>
          </>
        }
      >
        Closeness {pct}%
      </StatPillExplainer>
      {health && <HealthSparkline health={health} />}
      <Badge tone={tone} className="h-auto rounded-full px-3 py-1">
        {CLOSENESS_TIER_LABEL[closeness.tier]}
      </Badge>
      <Badge variant="outline" className="h-auto rounded-full px-3 py-1 font-normal text-muted-foreground">
        {lastLabel}
      </Badge>
      {constellation && (
        <ConstellationPinButton
          contactId={constellation.contactId}
          pin={constellation.pin}
          substantive={constellation.substantive}
        />
      )}
    </div>
  );
}
