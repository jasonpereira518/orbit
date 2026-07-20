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

export function RefreshContactsButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleRefresh() {
    if (pending) return;
    setPending(true);

    try {
      const { targets, hasApollo } = await listLinkedInRefreshTargets();

      if (targets.length === 0) {
        toast.message("No LinkedIn profiles to refresh", {
          description: "Add LinkedIn URLs to contacts first.",
        });
        return;
      }

      if (!hasApollo) {
        toast.error("Apollo API key required", {
          description:
            "Add your Apollo key in Settings → Outreach to refresh roles, schools, and photos.",
        });
        return;
      }

      let refreshed = 0;
      let unmatched = 0;
      let failed = 0;
      let avatarOnly = false;

      for (let i = 0; i < targets.length; i += LINKEDIN_REFRESH_BATCH_SIZE) {
        const chunk = targets.slice(i, i + LINKEDIN_REFRESH_BATCH_SIZE);
        const result = await refreshContactsFromLinkedIn(
          chunk.map((t) => t.id)
        );
        refreshed += result.refreshed;
        unmatched += result.unmatched;
        failed += result.failed;
        if (result.avatarOnly) avatarOnly = true;
      }

      if (refreshed > 0) {
        toast.success(
          avatarOnly
            ? `Updated photos for ${refreshed} contact${refreshed === 1 ? "" : "s"}`
            : `Refreshed ${refreshed} contact${refreshed === 1 ? "" : "s"} from LinkedIn`,
          avatarOnly
            ? {
                description:
                  "Role and school need a paid Apollo plan. Photos were refreshed from LinkedIn.",
              }
            : undefined
        );
      } else {
        toast.message("No profiles updated", {
          description:
            unmatched > 0
              ? "Could not match these LinkedIn URLs."
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
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      className="gap-1.5"
      aria-busy={pending}
      onClick={() => void handleRefresh()}
    >
      <RefreshCw
        className={cn("h-4 w-4", pending && "animate-spin")}
        aria-hidden
      />
      {pending ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
