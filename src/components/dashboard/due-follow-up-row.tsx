"use client";

import Link from "next/link";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";

export function DueFollowUpRow({
  id,
  fullName,
  title,
  company,
  nextFollowUpAt,
}: {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  relationshipScore: number;
  nextFollowUpAt?: Date | string | null;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/contacts/${id}`} className="min-w-0 hover:underline">
          <p className="font-medium text-primary">{fullName}</p>
          <p className="text-xs text-muted-foreground">
            {[title, company].filter(Boolean).join(" · ")}
          </p>
        </Link>
      </div>
      <EasyFollowUp
        contactId={id}
        nextFollowUpAt={nextFollowUpAt}
        compact
        className="mt-2"
      />
    </div>
  );
}
