"use client";

/**
 * Closeness as a line of five, with words. Real radios in one `name` group (arrow keys
 * work for free), the selected segment carried by the same `layoutId` pill every
 * segmented control uses. The label row is the legend the model was scored against.
 */
import { motion } from "motion/react";
import { CLOSENESS_LEVELS, clampCloseness, type ClosenessLevel } from "@/lib/capture/closeness";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function ClosenessControl({
  value,
  onChange,
  name,
  label = "How close are you?",
}: {
  value: number;
  onChange: (next: ClosenessLevel) => void;
  /** Unique per control: two cards in the stack must not share a radio group. */
  name: string;
  label?: string;
}) {
  const current = clampCloseness(value);
  const currentLabel = CLOSENESS_LEVELS.find((l) => l.value === current)?.label ?? "";
  return (
    <fieldset className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
        <span className="text-xs font-medium text-foreground sm:hidden" aria-hidden>
          {currentLabel}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-0 rounded-lg bg-muted p-[3px]" role="presentation">
        {CLOSENESS_LEVELS.map((level) => {
          const active = level.value === current;
          const id = `${name}-${level.value}`;
          return (
            <label
              key={level.value}
              htmlFor={id}
              className={cn(
                "relative flex cursor-pointer flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-center transition-colors",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={level.value}
                checked={active}
                onChange={() => onChange(level.value)}
                className="peer sr-only"
              />
              {active && (
                <motion.span
                  layoutId={`${name}-pill`}
                  className="absolute inset-0 rounded-md bg-background shadow-sm peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50"
                  transition={SPRING_PILL}
                />
              )}
              <span className="relative z-10 text-sm font-semibold tabular-nums">{level.value}</span>
              <span className="relative z-10 hidden text-[10px] leading-tight sm:block">{level.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
