import { formatLastTouch } from "@/lib/relative-date";
import { ConstellationPinButton } from "@/components/contacts/constellation-pin-button";
import { HealthSparkline } from "@/components/contacts/health-sparkline";
import { StatPillExplainer } from "@/components/contacts/stat-pill-explainer";
import { Badge } from "@/components/ui/badge";
import {
  closenessPercentChipClass,
  type ClosenessBreakdown,
} from "@/lib/closeness";
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
   * without this, an untouched LinkedIn import claims a "last touch" that never
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
      ? `Last touch ${since}`
      : `Connected ${since}`;

  return (
    // `items-center` so the constellation button sits on the same baseline as the badges —
    // it is a real button and slightly taller than they are.
    <div className="flex flex-wrap items-center gap-2">
      <StatPillExplainer
        label={`Closeness ${pct}%. Show what this means.`}
        className={closenessPercentChipClass(closeness.closeness)}
        title={`Closeness ${pct}% · how much they matter`}
        body={
          <>
            <p className="text-muted-foreground">
              Where this person sits in your network: your rating, how recently and how often
              you&apos;re in touch, and how they fit your goals — ranked against everyone else
              you know.
            </p>
            <p className="border-t pt-2 text-muted-foreground">
              Health, next to it, is how the conversation itself is going: reply speed, who
              writes, and recency.
            </p>
          </>
        }
      >
        Closeness {pct}%
      </StatPillExplainer>
      {health ? (
        <HealthSparkline health={health} />
      ) : (
        // Shown rather than left out: a missing pill reads as a bug, not as "no data".
        <StatPillExplainer
          label="Health: nothing recent to score. Show what this means."
          className="border border-dashed border-border bg-transparent font-normal text-muted-foreground"
          title="Health · nothing recent to score"
          body={
            <>
              <p className="text-muted-foreground">
                Health scores how the conversation is going — reply speed, who writes, and
                recency — from messages, emails and meetings in the last nine months. There
                haven&apos;t been any with this person in that time.
              </p>
              <p className="text-muted-foreground">
                Log a touch, or import your LinkedIn messages or email, and it will appear.
              </p>
            </>
          }
        >
          Health —
        </StatPillExplainer>
      )}
      <Badge
        variant="secondary"
        className="rounded-full px-3 py-1 text-xs font-medium capitalize"
      >
        {closeness.tier} orbit
      </Badge>
      <Badge
        variant="outline"
        className="rounded-full px-3 py-1 text-xs font-normal text-muted-foreground"
      >
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
