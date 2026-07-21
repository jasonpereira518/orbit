import { cn } from "@/lib/utils";

const TIER_LABELS = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
} as const;

const TIER_STYLES = {
  inner: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  mid: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  outer: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
} as const;

const TIER_DOT = {
  inner: "bg-emerald-500",
  mid: "bg-sky-500",
  outer: "bg-amber-500",
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
          TIER_DOT[tier],
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
