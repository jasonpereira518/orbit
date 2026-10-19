"use client";

import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
        {parts(failed)} couldn’t upload.{" "}
        {onRetry && (
          <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs text-destructive" onClick={onRetry}>
            Try again
          </Button>
        )}
      </p>
    );
  }
  if (pending > 0) {
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)} role="status">
        <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /> Saving {parts(pending)}…
      </p>
    );
  }
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)} role="status">
      <Check className="size-3 text-success" aria-hidden /> Everything’s saved
    </p>
  );
}
