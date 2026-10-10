"use client";

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Whether what was recorded has reached Orbit — so pausing feels safe. The upload queue keeps
 * draining while a meeting is paused, so the number is live: "Saving 2 parts…" falls to
 * "Everything's saved" without the user doing anything.
 */
export function MeetingSaveStatus({
  pending,
  failed,
  onRetry,
  className,
}: {
  /** Parts still queued, uploading or retrying. */
  pending: number;
  /** Parts that gave up. */
  failed: number;
  onRetry?: () => void;
  className?: string;
}) {
  const parts = (n: number) => `${n} part${n === 1 ? "" : "s"}`;
  if (failed > 0) {
    return (
      <p className={cn("text-xs text-destructive", className)} role="status">
        {parts(failed)} couldn&apos;t upload.{" "}
        {onRetry && (
          <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
            Retry
          </button>
        )}
      </p>
    );
  }
  if (pending > 0) {
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)} role="status">
        <Loader2 className="size-3 animate-spin" /> Saving {parts(pending)}…
      </p>
    );
  }
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)} role="status">
      <Check className="size-3 text-primary" /> Everything&apos;s saved
    </p>
  );
}
