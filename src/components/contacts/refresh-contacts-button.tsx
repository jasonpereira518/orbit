"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  listLinkedInRefreshTargets,
  refreshContactsFromLinkedIn,
} from "@/actions/contacts";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  finishBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";

type RefreshProgress = {
  done: number;
  total: number;
};

export function RefreshContactsButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<RefreshProgress | null>(null);

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  async function handleRefresh() {
    if (pending) return;
    setPending(true);
    setProgress({ done: 0, total: 0 });
    const jobId = `linkedin-refresh-${Date.now()}`;

    try {
      const { targets, hasApollo } = await listLinkedInRefreshTargets();

      if (targets.length === 0) {
        toast.message("No LinkedIn profiles to refresh", {
          description: "Add LinkedIn URLs to contacts first.",
        });
        return;
      }

      setProgress({ done: 0, total: targets.length });
      startBackgroundJob({
        id: jobId,
        kind: "linkedin-refresh",
        label: "Refreshing contacts from LinkedIn",
        done: 0,
        total: targets.length,
        startedAt: Date.now(),
      });

      let refreshed = 0;
      let unmatched = 0;
      let failed = 0;
      let avatarOnly = !hasApollo;
      let rateLimited = false;

      for (let i = 0; i < targets.length; i += LINKEDIN_REFRESH_BATCH_SIZE) {
        const chunk = targets.slice(i, i + LINKEDIN_REFRESH_BATCH_SIZE);
        const result = await refreshContactsFromLinkedIn(
          chunk.map((t) => t.id)
        );
        refreshed += result.refreshed;
        unmatched += result.unmatched;
        failed += result.failed;
        if (result.avatarOnly) avatarOnly = true;
        if (result.rateLimited) rateLimited = true;
        const done = Math.min(i + chunk.length, targets.length);
        setProgress({ done, total: targets.length });
        updateBackgroundJob(jobId, { done, total: targets.length });
      }

      let resultMessage: string;
      if (refreshed > 0) {
        resultMessage = avatarOnly
          ? `Updated photos for ${refreshed} contact${refreshed === 1 ? "" : "s"}`
          : `Refreshed ${refreshed} contact${refreshed === 1 ? "" : "s"} from LinkedIn`;
        toast.success(
          resultMessage,
          avatarOnly
            ? {
                description: hasApollo
                  ? "Role and school need a paid Apollo plan. Photos were refreshed from LinkedIn."
                  : "Photos refreshed from LinkedIn. Add an Apollo key in Settings to also update roles and schools.",
              }
            : undefined
        );
      } else if (rateLimited) {
        resultMessage = "Photo lookup rate limited";
        toast.message(resultMessage, {
          description:
            "LinkedIn photo providers are temporarily unavailable. Try again in a few minutes.",
        });
      } else {
        resultMessage = "No profiles updated";
        toast.message(resultMessage, {
          description:
            unmatched > 0
              ? "Couldn’t find public photos for these LinkedIn profiles. Check that each URL is a public linkedin.com/in/… link."
              : "Nothing changed.",
        });
      }

      if (failed > 0) {
        toast.error(
          `${failed} contact${failed === 1 ? "" : "s"} failed to refresh`
        );
      }

      finishBackgroundJob(jobId, { status: "completed", resultMessage });
      router.refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not refresh contacts";
      toast.error(message);
      finishBackgroundJob(jobId, { status: "failed", error: message });
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      className="relative gap-1.5 overflow-hidden pl-3.5"
      aria-busy={pending}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pending ? pct : undefined}
      role={pending ? "progressbar" : undefined}
      onClick={() => void handleRefresh()}
    >
      {pending ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 left-1 w-1 overflow-hidden rounded-full bg-border/80"
        >
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 rounded-full bg-primary transition-[height] duration-300 ease-out",
              progress ? "" : "h-0"
            )}
            style={progress ? { height: `${pct}%` } : undefined}
          />
        </span>
      ) : null}
      <RefreshCw
        className={cn("h-4 w-4", pending && "animate-spin")}
        aria-hidden
      />
      {pending && progress && progress.total > 0
        ? `${progress.done}/${progress.total}`
        : pending
          ? "Refreshing…"
          : "Refresh"}
    </Button>
  );
}
