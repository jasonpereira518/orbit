import { Crown, Infinity as InfinityIcon, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";

/**
 * Single source of truth for how a plan reads visually, so an "Orbit Pro" chip looks the
 * same whether it names a paywall's unlock plan (`LockedFeature`), a user's current plan
 * (`PlanSettings`) or a row in the admin roster.
 *
 * Colors come from the plan tokens in globals.css through the `data-plan` scope: Free neutral
 * teal, Pro blue, Max gold, Lifetime silver — each theme-aware and ≥ 4.5:1 as text on a card
 * (`scripts/smoke-tier-contrast.ts`). None of them borrows `--primary` or a chart color,
 * which flip hue between themes.
 */
const ICONS: Partial<Record<Plan, LucideIcon>> = {
  orbit: Sparkles,
  max: Crown,
  lifetime: InfinityIcon,
};

export function PlanBadge({ plan, className }: { plan: Plan; className?: string }) {
  const Icon = ICONS[plan];
  return (
    <span
      data-plan={plan}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        plan === "free"
          ? "border-border/70 text-muted-foreground"
          : "border-tier-border bg-tier-surface text-tier-accent",
        className
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden />}
      {PLAN_LABELS[plan]}
    </span>
  );
}
