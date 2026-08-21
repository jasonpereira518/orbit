"use client";

import { Lock } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PLAN_LABELS, PLAN_RING, type Plan } from "@/lib/plan-limits";
import { cn } from "@/lib/utils";

/**
 * The Orbit mark, wearing a ring that names the plan: blue for Orbit Pro, gold for
 * Orbit Lifetime, bare for Free.
 *
 * Drawn with box-shadow rather than a border so the ring sits outside the mark without
 * changing its box size — the sidebar header lays out against a fixed logo width, and a
 * border would nudge everything beside it.
 */
export function PlanLogo({
  plan,
  size = "md",
  className,
}: {
  plan: Plan;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const ring = PLAN_RING[plan];

  if (!ring) return <OrbitLogo size={size} className={className} />;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "relative inline-flex shrink-0 rounded-full outline-none",
              className
            )}
          />
        }
      >
        <OrbitLogo size={size} />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[3px] rounded-full"
          style={{ boxShadow: `0 0 0 2px ${ring}, 0 0 10px -1px ${ring}` }}
        />
        <span className="sr-only">Your plan: {PLAN_LABELS[plan]}</span>
      </TooltipTrigger>
      <TooltipContent side="right">{PLAN_LABELS[plan]}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Dims and slightly blurs a feature the current plan does not include, and names the
 * plans that do. Presentation only — the real boundary is `requireEntitlement` inside the
 * server actions, which holds even against a direct POST.
 *
 * The children stay in the accessibility tree unblurred to screen readers; the blur is a
 * visual affordance, and `label` carries the same meaning in text.
 */
export function FeatureLock({
  includedIn,
  label,
  children,
  className,
  lockClassName,
}: {
  /** e.g. "Orbit Pro and Orbit Lifetime" — from `includedInLabel(feature)`. */
  includedIn: string;
  /** Name of the locked thing, for the accessible description. */
  label: string;
  children: React.ReactNode;
  className?: string;
  lockClassName?: string;
}) {
  const message = `${label} is included in ${includedIn}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("relative inline-flex items-center outline-none", className)}
          />
        }
      >
        <span
          aria-hidden="true"
          className="pointer-events-none flex w-full items-center gap-2.5 opacity-55 blur-[1.1px]"
        >
          {children}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center",
            lockClassName
          )}
        >
          <Lock className="size-3.5 text-muted-foreground" />
        </span>
        <span className="sr-only">{message}</span>
      </TooltipTrigger>
      <TooltipContent side="right">Included in {includedIn}</TooltipContent>
    </Tooltip>
  );
}
