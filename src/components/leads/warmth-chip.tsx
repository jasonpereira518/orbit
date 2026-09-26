import type { Warmth } from "@/lib/leads/warm-path";
import { cn } from "@/lib/utils";

export const WARMTH_LABEL: Record<Warmth, string> = {
  hot: "Hot path",
  warm: "Warm path",
  cool: "Cool path",
  cold: "No path yet",
};

const WARMTH_HINT: Record<Warmth, string> = {
  hot: "A teammate knows them well — inner orbit",
  warm: "A teammate knows them, or two know them loosely",
  cool: "One loose connection, or someone at their company",
  cold: "Nobody on your team knows them yet",
};

/** The closeness-tier palette, one step warmer: emerald, sky, amber, then muted for none. */
const WARMTH_STYLE: Record<Warmth, string> = {
  hot: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warm: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  cool: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  cold: "bg-muted text-muted-foreground",
};

export function WarmthChip({ warmth, className }: { warmth: Warmth; className?: string }) {
  return (
    <span
      title={WARMTH_HINT[warmth]}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        WARMTH_STYLE[warmth],
        className
      )}
    >
      {WARMTH_LABEL[warmth]}
    </span>
  );
}
