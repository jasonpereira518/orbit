import { Badge } from "@/components/ui/badge";
import { TONE, type Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

const TIER_LABELS = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
} as const;

/** One tone per tier, on the status tokens: inner reads as success, mid as info, outer as warning. */
export const TIER_TONE: Record<keyof typeof TIER_LABELS, Tone> = {
  inner: "success",
  mid: "info",
  outer: "warning",
};

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
        className={cn("inline-block size-2 shrink-0 rounded-full", TONE[TIER_TONE[tier]].dot, className)}
        title={TIER_LABELS[tier]}
      />
    );
  }

  return (
    <Badge tone={TIER_TONE[tier]} size="sm" className={className}>
      {TIER_LABELS[tier]}
    </Badge>
  );
}
