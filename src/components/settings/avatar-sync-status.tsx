"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackgroundJobs } from "@/lib/background-jobs";

/**
 * Shows progress for the LinkedIn photo backfill (`avatar-backfill.tsx`),
 * which runs silently on every page load with no UI of its own. Renders
 * nothing once the job clears from the store (see AUTO_REMOVE_MS).
 */
export function AvatarSyncStatus() {
  const jobs = useBackgroundJobs();
  const job = jobs.find((j) => j.kind === "avatar-backfill");
  if (!job) return null;

  const determinate = job.total > 0;
  const pct = determinate
    ? Math.min(100, Math.round((job.done / job.total) * 100))
    : null;

  return (
    <div className="border-t border-border/60 pt-4">
      <h3 className="text-sm font-medium text-primary">Contact photos</h3>
      <div className="mt-2 flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          {job.status === "running" ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : job.status === "completed" ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : job.status === "failed" ? (
            <XCircle className="size-4 text-destructive" />
          ) : (
            <XCircle className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm text-muted-foreground">
            {job.status === "running"
              ? job.label
              : job.status === "completed"
                ? job.resultMessage || `${job.label} — done`
                : job.status === "failed"
                  ? job.error || `${job.label} failed`
                  : job.resultMessage || `${job.label} stopped`}
          </p>
          {job.status === "running" && (
            <div className="space-y-1">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-border/80"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={determinate ? pct! : undefined}
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
                    !determinate && "w-1/3 animate-pulse"
                  )}
                  style={determinate ? { width: `${pct}%` } : undefined}
                />
              </div>
              {determinate && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {job.done} of {job.total} · {pct}%
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
