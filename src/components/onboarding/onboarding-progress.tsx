"use client";

import { motion } from "motion/react";
import { Check } from "lucide-react";
import { DUR, EASE_HOUSE, SPRING_PILL } from "@/lib/motion";
import { STAGE_LABELS, type OnboardingStage } from "@/lib/onboarding-steps";
import { cn } from "@/lib/utils";

/**
 * Planets on an orbit line, one per main-line step of the chosen path. The line fills with
 * `scaleX` from its left edge and the current planet wears a `layoutId` ring, so moving
 * between stages is two compositor-only animations — never a `width`.
 *
 * `stages` is the path's main line with skipped steps already removed, so a person who
 * arrived with a key sees four planets, not five with one that never lights.
 */
export function OnboardingProgress({
  stages,
  stage,
}: {
  stages: readonly OnboardingStage[];
  stage: OnboardingStage;
}) {
  const index = Math.max(0, stages.indexOf(stage));
  const fraction = stages.length > 1 ? index / (stages.length - 1) : 1;

  return (
    <nav aria-label="Setup progress" className="flex flex-col items-center gap-2">
      <ol className="relative flex items-center gap-7 sm:gap-10">
        <span aria-hidden className="absolute inset-x-1.5 top-1/2 h-px -translate-y-1/2 bg-border" />
        <motion.span
          aria-hidden
          className="absolute inset-x-1.5 top-1/2 h-px origin-left -translate-y-1/2 bg-primary"
          initial={false}
          animate={{ scaleX: fraction }}
          transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
        />
        {stages.map((s, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <li key={s} className="relative flex size-3 items-center justify-center">
              {current && (
                <motion.span
                  layoutId="onboarding-progress-ring"
                  transition={SPRING_PILL}
                  aria-hidden
                  className="absolute -inset-1.5 rounded-full border border-primary/60 bg-primary/10"
                />
              )}
              <span
                className={cn(
                  "relative flex size-3 items-center justify-center rounded-full transition-colors duration-300",
                  done || current ? "bg-primary text-primary-foreground" : "bg-muted-foreground/25",
                )}
              >
                {done && <Check className="size-2" strokeWidth={4} aria-hidden />}
              </span>
              <span className="sr-only">
                {STAGE_LABELS[s]}
                {current ? " (current step)" : done ? " (done)" : ""}
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {STAGE_LABELS[stage]}
      </p>
    </nav>
  );
}
