"use client";

import { PLAN_SHORT_LABELS, type PurchasablePlan } from "@/lib/plans/plan-config";
import type { ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import { OnboardingMark } from "@/components/onboarding/onboarding-mark";
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

/**
 * Every step's top: the eyebrow (the small mark and the stage, "About you · 2 of 3"), a Fraunces
 * heading and one muted line. `text-ink`, not `text-primary`: they are the same teal in light,
 * and in dark `--primary` is the sky-blue accent that turned headings blue (theme.css, `--ink`).
 */
export function StepHeading({
  eyebrow,
  title,
  children,
  className,
  titleId,
  center = false,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  className?: string;
  titleId?: string;
  center?: boolean;
}) {
  return (
    <div className={cn("space-y-1.5", center && "flex flex-col items-center text-center", className)}>
      {eyebrow && (
        <StaggerItem>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink">
            <OnboardingMark size={16} />
            {eyebrow}
          </p>
        </StaggerItem>
      )}
      <StaggerItem>
        <h1
          id={titleId}
          className="font-[family-name:var(--font-display)] text-[1.75rem] leading-tight tracking-tight text-ink text-balance sm:text-3xl"
        >
          {title}
        </h1>
      </StaggerItem>
      {children && (
        <StaggerItem>
          <p className="max-w-xl text-sm text-muted-foreground text-pretty sm:text-[0.9375rem]">{children}</p>
        </StaggerItem>
      )}
    </div>
  );
}

/**
 * A main step's frame: Back, the heading, a middle region, and the footer pinned to the bottom
 * of the stage. The stage gives every step a bounded height from `md` up, so when content
 * outgrows it (a long company list, an error line) the middle scrolls, never the page.
 */
export function StepLayout({
  onBack,
  backDisabled,
  eyebrow,
  title,
  description,
  footer,
  className,
  children,
}: {
  onBack?: () => void;
  backDisabled?: boolean;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Stagger className={cn("mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col", className)}>
      <div className="shrink-0 space-y-2">
        {onBack && (
          <StaggerItem>
            <BackButton onClick={onBack} disabled={backDisabled} />
          </StaggerItem>
        )}
        <StepHeading eyebrow={eyebrow} title={title}>
          {description}
        </StepHeading>
      </div>
      {/* -mx/px and py keep focus rings clear of the scroll clip. */}
      <div className="-mx-1 mt-3 min-h-0 flex-1 px-1 pt-1 pb-1 md:overflow-y-auto">{children}</div>
      {footer}
    </Stagger>
  );
}

/** The pinned footer: "Skip for now" or a note on the left, the main button on the right. */
export function StepFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <StaggerItem className="mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </StaggerItem>
  );
}

export function BackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 h-9 text-muted-foreground"
      onClick={onClick}
      disabled={disabled}
    >
      <ChevronLeft className="size-4" aria-hidden />
      Back
    </Button>
  );
}

/** The card surface every onboarding choice and form sits on. */
export const CARD = "rounded-2xl border border-border/70 bg-card";

/** A rounded icon square: teal on light teal, or gold on light gold. */
export function IconBadge({
  icon: Icon,
  tone = "teal",
  size = "md",
}: {
  icon: LucideIcon;
  tone?: "teal" | "gold";
  size?: "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "lg" ? "size-12 rounded-2xl" : "size-9 rounded-xl",
        tone === "gold" ? "bg-gold/15 text-gold-ink" : "bg-accent text-primary",
      )}
    >
      <Icon className={size === "lg" ? "size-6" : "size-[1.125rem]"} />
    </span>
  );
}

/** An icon badge beside a title and a line of text; `trailing` takes a button. */
export function ChoiceRow({
  icon,
  tone,
  title,
  tag,
  trailing,
  children,
}: {
  icon: LucideIcon;
  tone?: "teal" | "gold";
  title: ReactNode;
  tag?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <span className="flex w-full min-w-0 items-start gap-3 text-left">
      <IconBadge icon={icon} tone={tone} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-ink">
          {title}
          {tag}
        </span>
        {children && <span className="mt-0.5 block text-[0.8125rem] leading-snug text-muted-foreground">{children}</span>}
      </span>
      {trailing && <span className="shrink-0 self-center">{trailing}</span>}
    </span>
  );
}

/** "Recommended": gold, so it never reads as a selected (teal) control. */
export function RecommendedTag() {
  return (
    <span className="inline-flex items-center rounded-full bg-gold/15 px-2 py-px text-xs font-semibold text-gold-ink">
      Recommended
    </span>
  );
}

/** A one-line note: gold for good news, muted for everything else. */
export function Note({
  icon: Icon,
  tone = "gold",
  role,
  children,
}: {
  icon: LucideIcon;
  tone?: "gold" | "muted";
  role?: "status";
  children: ReactNode;
}) {
  return (
    <p
      role={role}
      className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 text-[0.8125rem]",
        tone === "gold" ? "bg-gold/15 text-gold-ink" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A group's label, with an optional icon and a quieter aside ("up to 5"). */
export function GroupLabel({
  icon: Icon,
  aside,
  children,
}: {
  icon?: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="mb-2 flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
      {Icon && <Icon className="size-3.5 text-gold" aria-hidden />}
      {children}
      {aside && <span className="font-normal text-muted-foreground">{aside}</span>}
    </span>
  );
}

const TOGGLE_BASE =
  "inline-flex items-center gap-1.5 border text-[0.8125rem] transition-[border-color,background-color,color,transform] duration-200 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const TOGGLE_LOOK = {
  tile: "min-h-[3.75rem] flex-col justify-center rounded-xl px-2 py-2.5 text-center leading-tight",
  chip: "h-9 rounded-full px-3",
  segment:
    "min-h-9 flex-1 flex-col justify-center rounded-xl border-transparent px-2 py-1 text-center text-xs leading-tight sm:flex-none sm:flex-row sm:rounded-full sm:px-3 sm:text-[0.8125rem]",
} as const;

const TOGGLE_ROW = {
  tile: "grid grid-cols-2 gap-2 sm:grid-cols-4",
  chip: "flex min-w-0 flex-wrap gap-2",
  segment: "flex w-full gap-1 rounded-2xl bg-muted p-1 sm:inline-flex sm:w-auto sm:rounded-full",
} as const;

/**
 * One-of choices as real toggle buttons (`aria-pressed`); pressing the chosen one clears it,
 * so every answer stays optional. Three looks over one behaviour: `tile` for a single big
 * choice, `chip` for a short list, `segment` for a three-way switch. Every option has an icon
 * next to its label: teal at rest, gold on the selected teal fill.
 */
export function ToggleGroup<T extends string>({
  label,
  options,
  labels,
  icons,
  value,
  onChange,
  look,
  disabled = false,
  hint,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  icons: Record<T, LucideIcon>;
  value: T | null;
  onChange: (next: T | null) => void;
  look: keyof typeof TOGGLE_LOOK;
  disabled?: boolean;
  /** Said beside the label, e.g. why the group is disabled. */
  hint?: string;
}) {
  return (
    <div role="group" aria-label={label} className="min-w-0">
      <GroupLabel aside={hint}>{label}</GroupLabel>
      <div className={TOGGLE_ROW[look]}>
        {options.map((option) => {
          const on = value === option;
          const Icon: LucideIcon = icons[option];
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? null : option)}
              className={cn(
                TOGGLE_BASE,
                TOGGLE_LOOK[look],
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : look === "segment"
                    ? "text-foreground/80 hover:text-foreground"
                    : "border-border/70 bg-card text-foreground hover:border-primary/40",
              )}
            >
              <Icon className={cn("size-4 shrink-0", on ? "text-gold" : "text-primary")} aria-hidden />
              <span>{labels[option]}</span>
            </button>
          );
        })}
      </div>
    </div>
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
        "inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-warning",
        className,
      )}
    >
      Soon
    </span>
  );
}

/** The plan a locked line unlocks on (`unlockTagPlan`); Pro unless told otherwise. */
export function ProTag({ className, plan = "orbit" }: { className?: string; plan?: PurchasablePlan }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-brand-pro/35 bg-brand-pro/10 px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-tier-pro",
        className,
      )}
    >
      {PLAN_SHORT_LABELS[plan]}
    </span>
  );
}
