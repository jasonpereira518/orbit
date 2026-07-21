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

    try {
      const { targets, hasApollo } = await listLinkedInRefreshTargets();

      if (targets.length === 0) {
        toast.message("No LinkedIn profiles to refresh", {
          description: "Add LinkedIn URLs to contacts first.",
        });
        return;
      }

      setProgress({ done: 0, total: targets.length });

      let refreshed = 0;
      let unmatched = 0;
      let failed = 0;
      let avatarOnly = !hasApollo;

      for (let i = 0; i < targets.length; i += LINKEDIN_REFRESH_BATCH_SIZE) {
        const chunk = targets.slice(i, i + LINKEDIN_REFRESH_BATCH_SIZE);
        const result = await refreshContactsFromLinkedIn(
          chunk.map((t) => t.id)
        );
        refreshed += result.refreshed;
        unmatched += result.unmatched;
        failed += result.failed;
        if (result.avatarOnly) avatarOnly = true;
        setProgress({
          done: Math.min(i + chunk.length, targets.length),
          total: targets.length,
        });
      }

      if (refreshed > 0) {
        toast.success(
          avatarOnly
            ? `Updated photos for ${refreshed} contact${refreshed === 1 ? "" : "s"}`
            : `Refreshed ${refreshed} contact${refreshed === 1 ? "" : "s"} from LinkedIn`,
          avatarOnly
            ? {
                description: hasApollo
                  ? "Role and school need a paid Apollo plan. Photos were refreshed from LinkedIn."
                  : "Photos refreshed from LinkedIn. Add an Apollo key in Settings to also update roles and schools.",
              }
            : undefined
        );
      } else {
        toast.message("No profiles updated", {
          description:
            unmatched > 0
              ? "Could not fetch photos for these LinkedIn URLs."
              : "Nothing changed.",
        });
      }

      if (failed > 0) {
        toast.error(
          `${failed} contact${failed === 1 ? "" : "s"} failed to refresh`
        );
      }

      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not refresh contacts"
      );
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
