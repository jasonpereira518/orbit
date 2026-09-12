import { formatDistanceToNow } from "date-fns";
import { ConstellationPinButton } from "@/components/contacts/constellation-pin-button";
import { Badge } from "@/components/ui/badge";
import {
  closenessTierChipClass,
  type ClosenessBreakdown,
} from "@/lib/closeness";
import { cn } from "@/lib/utils";

export function ContactStatPills({
  closeness,
  lastTouchAt,
  hasLoggedInteraction,
  constellation,
}: {
  closeness: ClosenessBreakdown;
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
  const since = lastTouchAt
    ? formatDistanceToNow(new Date(lastTouchAt), { addSuffix: true })
    : null;
  const lastLabel = !since
    ? "No interactions yet"
    : hasLoggedInteraction
      ? `Last touch ${since}`
      : `Connected ${since}`;

  return (
    // `items-center` so the constellation button sits on the same baseline as the badges —
    // it is a real button and slightly taller than they are.
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant="secondary"
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium",
          closenessTierChipClass(closeness.tier)
        )}
      >
        Closeness {pct}%
      </Badge>
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
