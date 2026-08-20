"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MoreHorizontal, Plus, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  listLinkedInRefreshTargets,
  refreshContactsFromLinkedIn,
} from "@/actions/contacts";
import { LINKEDIN_REFRESH_BATCH_SIZE } from "@/lib/outreach-types";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RefreshContactsButton } from "@/components/contacts/refresh-contacts-button";
import { cn } from "@/lib/utils";

export function ContactsPageActions() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { targets, hasApollo } = await listLinkedInRefreshTargets();
      if (targets.length === 0) {
        toast.message("No LinkedIn profiles to refresh", {
          description: "Add LinkedIn URLs to contacts first.",
        });
        return;
      }

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
      }

      if (refreshed > 0) {
        toast.success(
          avatarOnly
            ? `Updated photos for ${refreshed} contact${refreshed === 1 ? "" : "s"}`
            : `Refreshed ${refreshed} contact${refreshed === 1 ? "" : "s"} from LinkedIn`
        );
      } else if (rateLimited) {
        toast.message("Photo lookup rate limited", {
          description:
            "LinkedIn photo providers are temporarily unavailable. Try again in a few minutes.",
        });
      } else {
        toast.message("No profiles updated", {
          description:
            unmatched > 0
              ? "Couldn’t find public photos for these LinkedIn profiles."
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
      setRefreshing(false);
    }
  }

  return (
    <>
      <div className="hidden items-center gap-2 sm:flex">
        <RefreshContactsButton />
        <Link
          href="/capture"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          AI capture
        </Link>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="sm:hidden"
              aria-label="More contact actions"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[11rem]">
          <DropdownMenuItem
            render={<Link href="/capture" className="cursor-pointer gap-2" />}
          >
            <Sparkles className="size-4" />
            AI capture
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={refreshing}
            className="gap-2"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin")}
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Link
        href="/contacts/new"
        className={cn(
          buttonVariants(),
          "bg-primary text-primary-foreground hover:bg-primary/90"
        )}
      >
        <Plus className="mr-1 h-4 w-4" />
        Add contact
      </Link>
    </>
  );
}
