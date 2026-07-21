"use client";

import Link from "next/link";
import { MessageSquarePlus, ScrollText } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import { cn } from "@/lib/utils";

export function ContactQuickActions({
  contactId,
  nextFollowUpAt,
}: {
  contactId: string;
  nextFollowUpAt?: string | Date | null;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        <a
          href="#interaction-timeline"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <ScrollText className="size-3.5" />
          Catch up
        </a>
        <a
          href="#suggested-message"
          className={cn(buttonVariants({ variant: "default", size: "sm" }))}
        >
          <MessageSquarePlus className="size-3.5" />
          Follow up
        </a>
        <Link
          href={`/capture?contactId=${contactId}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Log interaction
        </Link>
      </div>
      <EasyFollowUp
        contactId={contactId}
        nextFollowUpAt={nextFollowUpAt}
        compact
        className="sm:min-w-[220px]"
      />
    </div>
  );
}
