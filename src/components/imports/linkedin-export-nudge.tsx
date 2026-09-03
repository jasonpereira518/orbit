"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { dismissLinkedInExportNudge } from "@/actions/linkedin-export";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";

/**
 * Shown on the dashboard and on /imports while a requested LinkedIn export hasn't
 * arrived yet. Visibility (requested, not yet uploaded, under 30 days old) is decided by
 * the server caller via `getLinkedInExportStatus()` — this component only renders the
 * card and handles Dismiss once it's told to show.
 */
export function LinkedInExportNudge({
  requestedAt,
  showImportsLink = false,
}: {
  requestedAt: string;
  /** True on the dashboard mount, where "upload it here" needs an actual link to /imports.
   *  False (default) on the /imports mount, where the upload UI is already on the page. */
  showImportsLink?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  if (dismissed) return null;

  const requestedDate = new Date(requestedAt);
  const dateLabel = Number.isNaN(requestedDate.getTime())
    ? "recently"
    : formatDistanceToNow(requestedDate, { addSuffix: true });

  function handleDismiss() {
    startTransition(async () => {
      try {
        await dismissLinkedInExportNudge();
        setDismissed(true);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not dismiss"
        );
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
      <p className="text-ink">
        LinkedIn export requested {dateLabel} —{" "}
        {showImportsLink ? (
          <Link href="/imports" className="underline underline-offset-2">
            Open Imports
          </Link>
        ) : (
          "upload it here"
        )}{" "}
        when it arrives.
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        className="shrink-0 text-muted-foreground"
        onClick={handleDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}
