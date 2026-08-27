"use client";

import { useEffect, useRef, useState } from "react";
import { motion, type PanInfo } from "motion/react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
              {determinate
                ? `${job.done} of ${job.total} · ${pct}%${etaLabel ? ` · ${etaLabel}` : ""}`
                : "Working…"}
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
    </motion.div>
  );
}

// EMA blend weight given to each new throughput sample vs. the running
// average — mirrors the ETA smoothing already used for import progress bars
// (see components/imports/import-utils.tsx), just re-derived here because
// this version adds the never-increases guarantee below.
const RATE_EMA_NEW_WEIGHT = 0.45;
const ETA_MIN_ELAPSED_MS = 500;
const ETA_TICK_MS = 250;
// When the latest estimate would require the countdown to jump up, decay it
// at this fraction of real time instead — visibly still counting down, just
// slower, so it never appears to gain time.
const ETA_SLOWDOWN_FACTOR = 0.25;

/** Estimated time remaining for a determinate running job, formatted for
 * display. Based on a smoothed (EMA) recent-throughput rate, and guaranteed
 * to never tick upward — if the job falls behind pace the countdown decays
 * more slowly instead of jumping to a larger number. */
function useJobEtaLabel(job: BackgroundJob): string | null {
  const { done, total, startedAt, status } = job;
  const active = status === "running" && total > 0 && done > 0 && done < total;

  const [displayRemainingMs, setDisplayRemainingMs] = useState<number | null>(null);
  const rateEmaRef = useRef<number | null>(null);
  const lastDoneRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const knownStartedAtRef = useRef<number | null>(null);

  // One effect owns the whole lifecycle (rate tracking + the tick interval)
  // so "this is a fresh run" can be decided once and threaded through to the
  // interval's setState callback, instead of resetting display state from a
  // separate effect body.
  useEffect(() => {
    if (!active) return;

    const isNewRun = knownStartedAtRef.current !== startedAt;
    if (isNewRun) {
      knownStartedAtRef.current = startedAt;
      rateEmaRef.current = null;
      lastDoneRef.current = 0;
      lastTickRef.current = null;
    }

    if (lastDoneRef.current !== done) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= ETA_MIN_ELAPSED_MS) {
        lastDoneRef.current = done;
        const instantRate = done / elapsedMs; // items per ms
        if (instantRate > 0) {
          rateEmaRef.current =
            rateEmaRef.current == null
              ? instantRate
              : rateEmaRef.current * (1 - RATE_EMA_NEW_WEIGHT) +
                instantRate * RATE_EMA_NEW_WEIGHT;
        }
      }
    }

    const id = window.setInterval(() => {
      const nowTick = Date.now();
      const tickDeltaMs =
        lastTickRef.current == null ? 0 : Math.max(0, nowTick - lastTickRef.current);
      lastTickRef.current = nowTick;

      const rate = rateEmaRef.current;
      if (rate == null || rate <= 0) return;
      const targetRemainingMs = (total - done) / rate;

      setDisplayRemainingMs((prev) => {
        if (isNewRun || prev == null) return targetRemainingMs;
        const naturalNext = prev - tickDeltaMs;
        const onPaceOrAhead = targetRemainingMs <= naturalNext;
        const effectiveDelta = onPaceOrAhead
          ? tickDeltaMs
          : tickDeltaMs * ETA_SLOWDOWN_FACTOR;
        return Math.max(0, prev - effectiveDelta);
      });
    }, ETA_TICK_MS);

    return () => window.clearInterval(id);
  }, [active, done, total, startedAt]);

  // Stale once the job stops being active — the guard below hides it
  // immediately regardless, so there's nothing to reset here.
  if (!active) return null;
  return formatEtaSeconds(
    displayRemainingMs != null ? displayRemainingMs / 1000 : null
  );
}

function formatEtaSeconds(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole <= 1) return "~1s left";
  if (whole < 60) return `~${whole}s left`;
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  if (minutes < 60) {
    return rem > 0 ? `~${minutes}m ${rem}s left` : `~${minutes}m left`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `~${hours}h ${mins}m left` : `~${hours}h left`;
}
