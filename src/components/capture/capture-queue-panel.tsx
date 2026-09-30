"use client";

/**
 * The index over a multi-file drop: every capture the batch produced, and a way into each.
 *
 * This panel is the reason `queueCaptureJob` is allowed to skip its one-review-at-a-time
 * discard for a batch. That rule exists because a lone Extract has no way back to the cards
 * it displaced — there is no list of them. A batch has this, so the twelve meetings somebody
 * just uploaded stay reachable instead of eleven being thrown away.
 *
 * Each file is read in the background as its own job, but the upload is REVIEWED together:
 * once no file is still being read, the page folds the ready ones into a single job
 * (`mergeCaptureBatchRows`) and opens one deck, a card per person per note. So a ready row
 * here is waiting for the rest, not something to open on its own; only a failed row opens,
 * to show its error and let it be retried. There is still no "save all" — every card is seen.
 */
import { Check, CircleAlert, Loader2 } from "lucide-react";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { CaptureJobStatus } from "@/lib/capture/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Statuses where the job is still working and the row should not invite a click yet. */
const BUSY: ReadonlyArray<CaptureJobStatus> = ["ingesting", "transcribed", "queued", "extracting", "saving"];

const STATUS_LABEL: Partial<Record<CaptureJobStatus, string>> = {
  ingesting: "Reading",
  transcribed: "Read",
  queued: "Queued",
  extracting: "Pulling out people",
  ready: "Read",
  reviewing: "In review",
  saving: "Saving",
  saved: "Saved",
  failed: "Failed",
  discarded: "Discarded",
};

function peopleCount(job: CaptureJobView) {
  return job.result?.items?.length ?? 0;
}

export function CaptureQueuePanel({
  jobs,
  activeJobId,
  onOpen,
  onDiscardAll,
}: {
  jobs: CaptureJobView[];
  activeJobId: string | null;
  onOpen: (jobId: string) => void;
  onDiscardAll?: () => void;
}) {
  if (jobs.length <= 1) return null;

  const ready = jobs.filter((j) => j.status === "ready" || j.status === "reviewing").length;
  const busy = jobs.filter((j) => BUSY.includes(j.status)).length;
  const saved = jobs.filter((j) => j.status === "saved").length;

  return (
    <section
      aria-label="Captures from this upload"
      className="space-y-3 rounded-2xl border border-border/70 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">This upload</h3>
          <p className="text-xs text-muted-foreground">
            {saved} saved · {ready} ready · {busy} still reading
          </p>
        </div>
        {onDiscardAll && (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscardAll}>
            Discard all
          </Button>
        )}
      </div>

      <ul className="space-y-1.5">
        {jobs.map((job) => {
          const isBusy = BUSY.includes(job.status);
          // Only a failure opens alone; a ready file joins the combined review.
          const opensAlone = job.status === "failed";
          const isActive = job.id === activeJobId;
          const people = peopleCount(job);
          return (
            <li key={job.id}>
              <button
                type="button"
                disabled={!opensAlone}
                onClick={() => onOpen(job.id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                  isActive
                    ? "border-primary/40 bg-primary/5"
                    : "border-border/60 hover:bg-muted/50",
                  !opensAlone && "cursor-default hover:bg-transparent",
                  isBusy && "opacity-70"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {job.sourceLabel ?? "Untitled note"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {STATUS_LABEL[job.status] ?? job.status}
                    {job.status === "ready" && people > 0
                      ? ` · ${people} ${people === 1 ? "person" : "people"}`
                      : ""}
                    {job.error ? ` · ${job.error}` : ""}
                  </span>
                </span>

                {job.status === "saved" ? (
                  <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : job.status === "failed" ? (
                  <CircleAlert className="size-4 shrink-0 text-destructive" />
                ) : isBusy ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Badge variant="secondary" className="font-normal">
                    {busy > 0 ? "Waiting for the rest" : "Reviewing together"}
                  </Badge>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
