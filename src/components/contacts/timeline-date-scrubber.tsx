"use client";

import { useMemo } from "react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

export type TimelineScrubPoint = {
  id: string;
  /** yyyy-MM */
  monthKey: string;
  label: string;
  /** Short label for dense scrubber, e.g. "Mar" or "3" */
  shortLabel: string;
};

/**
 * Vertical month scrubber — one clickable dot per month to jump the timeline.
 */
export function TimelineDateScrubber({
  points,
  activeMonthKey,
  onSelectMonth,
  className,
}: {
  points: TimelineScrubPoint[];
  activeMonthKey: string | null;
  onSelectMonth: (monthKey: string) => void;
  className?: string;
}) {
  const uniqueMonths = useMemo(() => {
    const seen = new Map<string, TimelineScrubPoint>();
    for (const p of points) {
      if (!seen.has(p.monthKey)) seen.set(p.monthKey, p);
    }
    return [...seen.values()];
  }, [points]);

  if (uniqueMonths.length === 0) return null;

  const activeIdx = Math.max(
    0,
    uniqueMonths.findIndex((p) => p.monthKey === activeMonthKey)
  );

  return (
    <div
      className={cn(
        "flex h-full min-h-[12rem] w-14 shrink-0 flex-col items-center select-none",
        className
      )}
      aria-label="Jump to month"
    >
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Jump
      </p>
      <nav
        className="relative flex h-full min-h-0 w-full flex-1 flex-col justify-between py-1"
        aria-label="Timeline months"
      >
        <div
          className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-border"
          aria-hidden
        />
        {uniqueMonths.map((p, i) => {
          const isActive = p.monthKey === activeMonthKey;
          return (
            <button
              key={p.monthKey}
              type="button"
              title={p.label}
              aria-label={`Jump to ${p.label}`}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSelectMonth(p.monthKey)}
              className={cn(
                "group relative z-[1] flex w-full flex-col items-center gap-1 rounded-md py-0.5 outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              )}
            >
              <span
                className={cn(
                  "size-2.5 rounded-full border-2 transition-all",
                  isActive
                    ? "scale-125 border-primary bg-primary shadow-sm"
                    : "border-muted-foreground/50 bg-card group-hover:border-primary group-hover:bg-primary/20"
                )}
              />
              <span
                className={cn(
                  "text-[10px] leading-none transition-colors",
                  isActive
                    ? "font-semibold text-primary"
                    : "text-muted-foreground group-hover:text-foreground"
                )}
              >
                {p.shortLabel}
              </span>
              {i === activeIdx ? (
                <span className="sr-only">(current)</span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <p className="mt-2 max-w-full truncate text-center text-[10px] text-muted-foreground">
        {uniqueMonths[activeIdx]?.label}
      </p>
    </div>
  );
}

export function monthKeyFromDate(d: Date | string) {
  return format(new Date(d), "yyyy-MM");
}

export function monthLabel(d: Date | string) {
  return format(new Date(d), "MMM yyyy");
}

export function monthShort(d: Date | string) {
  return format(new Date(d), "MMM");
}
