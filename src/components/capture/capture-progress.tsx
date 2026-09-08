"use client";

/**
 * What "Extract people" shows while it runs.
 *
 * The button used to read "Parsing…" through an identify call, one detail call per four
 * people, excerpt retries, a concurrent commitment extraction and a duplicate scan — five
 * or more sequential model calls with a 45s deadline each, and nothing to look at.
 *
 * Built from the idiom already in `import-utils.tsx` (`role="status"`, a Loader2, the
 * two-div bar with `role="progressbar"`) rather than a new one, and it borrows
 * `global-job-progress-bar.tsx`'s indeterminate variant for the stages that have nothing
 * honest to count. Only `detailing` reports a fraction, because only `detailing` knows one.
 */

import { Loader2 } from "lucide-react";
import {
  CAPTURE_STAGE_LABEL,
  type CaptureStage,
} from "@/lib/capture-stream-protocol";
import { cn } from "@/lib/utils";

export type CaptureProgressState = {
  stage: CaptureStage;
  done?: number;
  total?: number;
};

/** The order stages occur in, for the step list. */
const STAGES: CaptureStage[] = [
  "reading",
  "identifying",
  "detailing",
  "dating",
  "matching",
];

export function CaptureProgress({
  state,
  compact,
  onCancel,
}: {
  state: CaptureProgressState;
  compact?: boolean;
  onCancel?: () => void;
}) {
  const determinate =
    state.stage === "detailing" &&
    typeof state.total === "number" &&
    state.total > 0;
  const pct = determinate
    ? Math.round(((state.done ?? 0) / (state.total as number)) * 100)
    : 0;
  const currentIndex = STAGES.indexOf(state.stage);

  const label = determinate
    ? `${CAPTURE_STAGE_LABEL[state.stage]} (${state.done ?? 0} of ${state.total})`
    : CAPTURE_STAGE_LABEL[state.stage];

  return (
    <section
      className={cn(
        "space-y-3 rounded-2xl border border-border/70 bg-card",
        compact ? "p-3.5" : "p-5"
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          {label}
        </p>
        {onCancel && (
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-border/80"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct : undefined}
        aria-label={label}
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary",
            determinate
              ? "transition-[width] duration-slow ease-house"
              : // No total to divide by yet: a moving third reads as "working" without
                // claiming progress it cannot measure.
                "w-1/3 animate-pulse"
          )}
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>

      {!compact && (
        <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {STAGES.map((stage, i) => (
            <li
              key={stage}
              className={cn(
                i === currentIndex && "font-medium text-foreground",
                i < currentIndex && "line-through opacity-60"
              )}
            >
              {CAPTURE_STAGE_LABEL[stage]}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
