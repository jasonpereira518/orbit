"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SuggestionRow } from "@/components/dashboard/suggestion-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PREVIEW_COUNT = 5;

export type SuggestedOutreachItem = {
  id: string;
  suggestionType: string;
  description: string | null;
  contactId: string | null;
  contactName: string;
  contactTitle?: string | null;
  contactCompany?: string | null;
  tier?: "inner" | "mid" | "outer";
};

export function SuggestedOutreachCard({
  items,
  networkIsEmpty,
  dueFollowUpCount,
}: {
  items: SuggestedOutreachItem[];
  /** No contacts at all — the only case where "add contacts" is the right advice. */
  networkIsEmpty: boolean;
  /** Suggestions for people already listed as due are filtered out; say where they went. */
  dueFollowUpCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PREVIEW_COUNT;
  const visible = expanded ? items : items.slice(0, PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Suggested outreach</CardTitle>
        <Link
          href="/capture"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent
        id="suggestions"
        className="flex flex-1 flex-col space-y-2 scroll-mt-8"
      >
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            {/* "Add contacts or log interactions" was shown to accounts with 24 contacts
                and six overdue follow-ups, because anyone already listed as due is
                filtered out of this queue. Say what is actually true instead. */}
            {networkIsEmpty
              ? "No one to reach out to yet — once you add people, Orbit watches for who's gone quiet."
              : dueFollowUpCount > 0
                ? `Nothing extra to suggest — your ${dueFollowUpCount} due follow-up${
                    dueFollowUpCount === 1 ? "" : "s"
                  } are the priority right now.`
                : "Nobody has gone quiet. Log an interaction and Orbit will keep watching."}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {visible.map((s) => (
                <SuggestionRow
                  key={s.id}
                  id={s.id}
                  suggestionType={s.suggestionType}
                  description={s.description}
                  contactId={s.contactId}
                  contactName={s.contactName}
                  contactTitle={s.contactTitle}
                  contactCompany={s.contactCompany}
                  tier={s.tier}
                />
              ))}
            </div>
            {hasMore ? (
              <div className="mt-auto pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded
                    ? "See less"
                    : `See more${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
