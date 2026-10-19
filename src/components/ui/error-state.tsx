"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * An inline "this part couldn't load" block, for a streamed section that failed.
 *
 * Distinct from `EmptyState` on purpose: a read that failed is not "nothing here yet", and
 * several pages used to `.catch(() => null)` their way into saying exactly that. Pair with
 * `error-fallback.tsx`, which owns the whole-page case.
 */
export function ErrorState({
  title = "Couldn’t load this",
  description = "Something went wrong on our side. Try again in a moment.",
  onRetry,
  retryLabel = "Try again",
  pending = false,
  action,
  size = "default",
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  pending?: boolean;
  /** Replaces the retry button, e.g. a link to the full page. */
  action?: ReactNode;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center rounded-xl border border-destructive/30 bg-destructive/8 text-center",
        size === "sm" ? "px-4 py-5" : "px-6 py-8",
        className
      )}
    >
      <p className={cn("font-medium text-ink", size === "sm" ? "text-sm" : "text-base")}>{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {(onRetry || action) && (
        <div className="mt-4 flex items-center gap-2">
          {action ??
            (onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={pending}>
                {pending ? "Trying…" : retryLabel}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
