import { cn } from "@/lib/utils";

const TIER_LABELS = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
} as const;

const TIER_STYLES = {
  inner: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  mid: "bg-primary/15 text-primary",
  outer: "bg-muted text-muted-foreground",
} as const;

export function ClosenessTierBadge({
  tier,
  className,
  dotOnly,
}: {
  tier: "inner" | "mid" | "outer";
  className?: string;
  dotOnly?: boolean;
}) {
  if (dotOnly) {
    return (
      <span
        className={cn(
          "inline-block h-2 w-2 shrink-0 rounded-full",
          tier === "inner" && "bg-amber-500",
          tier === "mid" && "bg-primary",
          tier === "outer" && "bg-muted-foreground/40",
          className
        )}
        title={TIER_LABELS[tier]}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        TIER_STYLES[tier],
        className
      )}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}
