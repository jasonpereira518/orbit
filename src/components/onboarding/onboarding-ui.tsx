"use client";

import type { ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the onboarding steps, so every step arrives the same way.
 *
 * Children rise 8px and fade in 50ms apart. `y` stays a motion value rather than a
 * transform string on purpose: AppShell's `MotionConfig reducedMotion="user"` makes transform
 * animations instant, and an entrance that jumps its 8px while still at opacity 0 lands in
 * place and only fades — so no branch is needed here. (Exits are different: see the step
 * slide in onboarding-flow.tsx.)
 */

const STAGGER: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.05, delayChildren: 0.06 } },
};

const ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_HOUSE } },
};

export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "ul" | "ol";
}) {
  const Component = as === "ul" ? motion.ul : as === "ol" ? motion.ol : motion.div;
  return (
    <Component variants={STAGGER} initial="hidden" animate="shown" className={className}>
      {children}
    </Component>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  const Component = as === "li" ? motion.li : motion.div;
  return (
    <Component variants={ITEM} className={className}>
      {children}
    </Component>
  );
}

export function StepHeading({
  eyebrow,
  title,
  children,
  className,
  titleId,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {eyebrow && (
        <StaggerItem>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-primary">{eyebrow}</p>
        </StaggerItem>
      )}
      <StaggerItem>
        <h1
          id={titleId}
          className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-ink text-balance sm:text-4xl"
        >
          {title}
        </h1>
      </StaggerItem>
      {children && (
        <StaggerItem>
          <p className="max-w-xl text-base text-muted-foreground text-pretty">{children}</p>
        </StaggerItem>
      )}
    </div>
  );
}

export function BackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      onClick={onClick}
      disabled={disabled}
    >
      <ChevronLeft className="size-4" />
      Back
    </Button>
  );
}

/**
 * A small "Pro" tag for features the viewer's plan does not include. Same tier colours as
 * `PlanBadge` — `text-tier-pro`, because the flat brand blue fails contrast on a light card.
 */
/** "Coming soon" — `--warning` amber, never Lifetime gold, which reads as a paid tier. */
export function SoonTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warning",
        className,
      )}
    >
      Soon
    </span>
  );
}

export function ProTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-brand-pro/35 bg-brand-pro/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-tier-pro",
        className,
      )}
    >
      Pro
    </span>
  );
}
