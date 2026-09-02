import { formatDistanceToNow } from "date-fns";
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
    <div className="flex flex-wrap gap-2">
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
    </div>
  );
}
