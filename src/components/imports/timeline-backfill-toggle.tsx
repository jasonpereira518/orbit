"use client";

import { useEffect, useState, useTransition } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getTimelineBackfillStatus,
  setTimelineBackfillEnabled,
} from "@/actions/timeline-backfill";
import type { TimelineBackfillStatus } from "@/lib/timeline-cost";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * The opt-in for deriving timeline events from imported LinkedIn conversations (audit A6).
 * Off by default; the label carries the estimate BEFORE the person turns it on. `refreshKey`
 * re-reads the count when an import finishes, since that is when conversations appear.
 */
export function TimelineBackfillToggle({
  refreshKey,
}: {
  refreshKey?: unknown;
}) {
  const [status, setStatus] = useState<TimelineBackfillStatus | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    getTimelineBackfillStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!status) return null;

  const change = (checked: boolean) =>
    start(async () => {
      try {
        setStatus(await setTimelineBackfillEnabled(checked));
        toast.success(
          checked
            ? `Timeline events on — up to ${status.dailyCap} conversations a day`
            : "Timeline events off",
        );
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
      <Checkbox
        checked={status.enabled}
        disabled={pending}
        onCheckedChange={(checked) => change(checked === true)}
        aria-label="Derive timeline events from LinkedIn conversations"
        className="mt-0.5"
      />
      <span className="min-w-0 text-sm">
        <span className="block font-medium text-ink tabular-nums">
          {status.label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Finds meetings and meetups in your threads and adds them to each
          person’s timeline. One call per conversation on {status.model}, up to{" "}
          {status.dailyCap} a day; threads with a single message get only a
          reach-out, with no AI call.
          {status.hasKey
            ? ""
            : " Without an AI key, Orbit falls back to simple keyword matching."}
        </span>
      </span>
    </label>
  );
}
