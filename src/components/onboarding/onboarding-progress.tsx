"use client";

import { motion } from "motion/react";
import { SPRING_PILL } from "@/lib/motion";
import { STAGE_LABELS, type OnboardingStage } from "@/lib/onboarding-steps";
import { cn } from "@/lib/utils";

/**
 * A named stepper, one stop per main-line step of the chosen path: gold dots for done stages,
 * the current one as a teal pill carrying its label, muted dots for the rest. The pill is a
 * `layoutId`, so moving between stages slides it rather than re-laying the row out. The About
 * sub-step ("· 2 of 3") is the eyebrow's, not the stepper's.
 *
 * `stages` is the path's main line with skipped steps already removed, so a person who
 * arrived with a key sees four stops, not five with one that never lights.
 */
export function OnboardingProgress({
  stages,
  stage,
}: {
  stages: readonly OnboardingStage[];
  stage: OnboardingStage;
}) {
  const index = Math.max(0, stages.indexOf(stage));

  return (
    <nav aria-label="Setup progress" className="flex justify-center">
      <ol className="flex items-center gap-1.5">
        {stages.map((s, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <li key={s} className="relative flex h-6 items-center">
              {current ? (
                <span className="relative inline-flex h-6 items-center px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground">
                  <motion.span
                    layoutId="onboarding-progress-ring"
                    transition={SPRING_PILL}
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-primary"
                  />
                  <span className="relative">{STAGE_LABELS[s]}</span>
                  <span className="sr-only"> (current step)</span>
                </span>
              ) : (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "block size-2 rounded-full transition-colors duration-300",
                      done ? "bg-gold" : "bg-muted-foreground/25",
                    )}
                  />
                  <span className="sr-only">
                    {STAGE_LABELS[s]}
                    {done ? " (done)" : ""}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
