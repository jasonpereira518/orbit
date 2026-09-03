"use client";

import { useState } from "react";
import { motion, type PanInfo } from "motion/react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEtaCountdown } from "@/lib/use-eta-countdown";
import { toast } from "@/lib/toast";
import {
  dismissBackgroundJob,
  hideBackgroundJobFromWidget,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";

/**
 * Persistent, page-independent progress list for large imports/batches/
 * background tasks — mounted once in the app shell so it stays visible
 * across navigation. Mirrors the same jobs shown in the notification panel,
 * except avatar-backfill, which is silent here and shown in Settings instead.
 */
export function GlobalJobProgressBar() {
  // avatar-backfill runs silently on every page load; it gets its own
  // progress display in Settings instead of a bottom-right toast. Jobs
  // swiped away stay in the store (and the notification center) but drop
  // out of this widget.
  const jobs = useBackgroundJobs().filter(
    (job) => job.kind !== "avatar-backfill" && !job.hiddenFromWidget
  );
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

// How far (px) or how fast (px/s) a swipe has to travel before it counts as
// a dismiss rather than a tap or an aborted drag.
const SWIPE_DISMISS_DISTANCE = 90;
const SWIPE_DISMISS_VELOCITY = 500;

function JobRow({ job }: { job: BackgroundJob }) {
  const determinate = job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
  const etaLabel = useJobEtaLabel(job);
  const [dismiss, setDismiss] = useState<{ exitX: number } | null>(null);

  function handleDragEnd(_event: unknown, info: PanInfo) {
    const past =
      Math.abs(info.offset.x) > SWIPE_DISMISS_DISTANCE ||
      Math.abs(info.velocity.x) > SWIPE_DISMISS_VELOCITY;
    if (!past) return;
    setDismiss({ exitX: info.offset.x >= 0 ? 320 : -320 });
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={
        dismiss
          ? { opacity: 0, x: dismiss.exitX }
          : { opacity: 1, y: 0, scale: 1, x: 0 }
      }
      transition={dismiss ? { duration: 0.22, ease: "easeIn" } : undefined}
      onAnimationComplete={() => {
        if (!dismiss) return;
        hideBackgroundJobFromWidget(job.id);
        toast.success("Moved to notifications");
      }}
      drag={dismiss ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      onDragEnd={handleDragEnd}
      style={{ touchAction: "pan-y" }}
      className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-card/95 p-3 shadow-lg backdrop-blur-md active:cursor-grabbing"
    >
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
        <p className="truncate text-sm font-medium text-ink">
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
              {determinate
                ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()} · ${pct}%${etaLabel ? ` · ${etaLabel}` : ""}`
                : "Working…"}
            </p>
            {job.imported != null ? (
              <p className="text-xs tabular-nums text-muted-foreground">
                {job.imported.toLocaleString()} {job.importedLabel ?? "imported"}
              </p>
            ) : null}
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
    </motion.div>
  );
}

/** Estimated time remaining for a running job, formatted for display. Guaranteed to never
 * tick upward — see `useEtaCountdown`, which this and the in-page import progress card share
 * so there's exactly one countdown algorithm in the codebase. */
function useJobEtaLabel(job: BackgroundJob): string | null {
  return useEtaCountdown({
    active: job.status === "running" && job.total > 0 && job.done > 0 && job.done < job.total,
    done: job.done,
    total: job.total,
    startedAt: job.startedAt,
  });
}
