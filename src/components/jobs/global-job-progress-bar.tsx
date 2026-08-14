"use client";

import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  dismissBackgroundJob,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";

/**
 * Persistent, page-independent progress list for large imports/batches/
 * background tasks — mounted once in the app shell so it stays visible
 * across navigation. Mirrors the same jobs shown in the notification panel.
 */
export function GlobalJobProgressBar() {
  const jobs = useBackgroundJobs();
  if (jobs.length === 0) return null;

  return (
    <div
      className="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-3 z-40 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-2 md:bottom-5 md:right-5"
      role="status"
      aria-live="polite"
    >
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
    </div>
  );
}

function JobRow({ job }: { job: BackgroundJob }) {
  const determinate = job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-card/95 p-3 shadow-lg backdrop-blur-md">
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
        <p className="truncate text-sm font-medium text-primary">
          {job.status === "running"
            ? job.cancelling
              ? "Stopping…"
              : job.label
            : job.status === "completed"
              ? job.resultMessage || `${job.label} — done`
              : job.status === "failed"
                ? job.error || `${job.label} failed`
                : job.resultMessage || `${job.label} stopped`}
        </p>

        {job.status === "running" && (
          <div className="space-y-1">
            <div
              className="h-2 overflow-hidden rounded-full bg-border/80"
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
            <p className="text-xs tabular-nums text-muted-foreground">
              {determinate ? `${job.done} of ${job.total} · ${pct}%` : "Working…"}
            </p>
          </div>
        )}
      </div>

      {job.status === "running" && job.onCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={job.cancelling}
          onClick={job.onCancel}
          aria-label={`Stop ${job.label}`}
          title="Stop"
        >
          <X className="size-3.5" />
        </Button>
      ) : job.status !== "running" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => dismissBackgroundJob(job.id)}
          aria-label={`Dismiss ${job.label}`}
          title="Dismiss"
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
