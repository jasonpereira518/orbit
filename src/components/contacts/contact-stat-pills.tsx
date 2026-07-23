import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  closenessPercentChipClass,
  type ClosenessBreakdown,
} from "@/lib/closeness";
import { cn } from "@/lib/utils";

export function ContactStatPills({
  closeness,
  lastTouchAt,
}: {
  closeness: ClosenessBreakdown;
  lastTouchAt: Date | string | null;
}) {
  const pct = Math.round(closeness.closeness * 100);
  const lastLabel = lastTouchAt
    ? `Last touch ${formatDistanceToNow(new Date(lastTouchAt), { addSuffix: true })}`
    : "No interactions yet";

  return (
    <div className="flex flex-wrap gap-2">
      <Badge
        variant="secondary"
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium",
          closenessPercentChipClass(closeness.closeness)
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
