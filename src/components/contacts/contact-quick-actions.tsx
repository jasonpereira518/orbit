"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquarePlus, ScrollText } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import { FollowUpDraftSheet } from "@/components/follow-up/follow-up-draft-sheet";
import { cn } from "@/lib/utils";

export function ContactQuickActions({
  contactId,
  contactName,
  nextFollowUpAt,
}: {
  contactId: string;
  contactName: string;
  nextFollowUpAt?: string | Date | null;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

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
        <Button type="button" size="sm" onClick={() => setSheetOpen(true)}>
          <MessageSquarePlus className="size-3.5" />
          Follow up
        </Button>
        <Link
          href={`/capture?contactId=${contactId}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Log interaction
        </Link>
      </div>
      <EasyFollowUp
        contactId={contactId}
        contactName={contactName}
        nextFollowUpAt={nextFollowUpAt}
        compact
        className="sm:min-w-[220px]"
      />
      <FollowUpDraftSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        contactId={contactId}
        contactName={contactName}
      />
    </div>
  );
}
