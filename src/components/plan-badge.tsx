import { Sparkles, Crown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";

/**
 * Single source of truth for how a tier reads visually, so a "Orbit Pro" or "Orbit
 * Lifetime" chip looks the same whether it is naming a paywall's unlock tiers
 * (`LockedFeature`) or a user's current plan (`PlanSettings`).
 *
 * Orbit Pro is a dedicated blue (`#599de7`, matching the ring in orbit-logo.tsx and
 * the pricing page's Orbit Pro card) rather than `--primary`: primary is teal in the
 * light theme, which is also the app's everyday chrome color, so a badge in that
 * color didn't read as a distinct tier. Orbit Lifetime gets `--tier-lifetime`, a
 * gold kept separate from `--chart-4` on purpose: the chart tokens flip hue between
 * themes (gold in light, blue in dark), which would make the Lifetime badge
 * silently match the Pro badge in dark mode.
 */
const TIER_ACCENT: Partial<Record<Plan, { icon: LucideIcon; className: string }>> = {
  orbit: {
    icon: Sparkles,
    className: "border-[#599de7]/35 bg-[#599de7]/10 text-[#2f68b0] dark:text-[#599de7]",
  },
  lifetime: {
    icon: Crown,
    className: "border-tier-lifetime/35 bg-tier-lifetime/10 text-tier-lifetime",
  },
};

export function PlanBadge({ plan, className }: { plan: Plan; className?: string }) {
  const accent = TIER_ACCENT[plan];

  if (!accent) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-muted-foreground",
          className
        )}
      >
        {PLAN_LABELS[plan]}
      </span>
    );
  }

  const Icon = accent.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        accent.className,
        className
      )}
    >
      <Icon className="size-3.5" />
      {PLAN_LABELS[plan]}
    </span>
  );
}
