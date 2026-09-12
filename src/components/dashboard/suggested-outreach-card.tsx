"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SuggestionRow } from "@/components/dashboard/suggestion-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PREVIEW_COUNT = 5;

/** Shared by the preview list and its collapsed overflow so both lay out alike. */
const LIST_CLASS =
  "space-y-2 @3xl:grid @3xl:grid-cols-2 @3xl:gap-2 @3xl:space-y-0";

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
  const preview = items.slice(0, PREVIEW_COUNT);
  const overflow = items.slice(PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle as="h2" className="text-base">Suggested outreach</CardTitle>
        <Link
          href="/capture"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent
        id="suggestions"
        // @container so the list below can respond to THIS CARD's width rather than
        // the viewport's. The card is half-width when Outreach performance is
        // showing and full-width when it isn't (that card removes itself for any
        // account that has never run a campaign — most of them), and a viewport
        // breakpoint cannot tell those apart.
        className="@container flex flex-1 flex-col space-y-2 scroll-mt-8"
      >
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            {/* "Add contacts or log interactions" was shown to accounts with 24 contacts
                and six overdue follow-ups, because anyone already listed as due is
                filtered out of this queue. Say what is actually true instead. */}
            {networkIsEmpty
              ? "No one to reach out to yet — add a contact or import your network."
              : dueFollowUpCount > 0
                ? `Nothing extra to suggest — your ${dueFollowUpCount} due follow-up${
                    dueFollowUpCount === 1 ? "" : "s"
                  } are the priority right now.`
                : "Nobody has gone quiet. Log an interaction and Orbit will keep watching."}
          </p>
        ) : (
          <>
            {/* Two-up once the card itself is past ~768px. Stretched to a full
                row, a suggestion put its name a thousand pixels from its own
                dismiss button with nothing in between. */}
            <div className={LIST_CLASS}>
              {preview.map((s) => (
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
              <>
                {/* The overflow stays mounted and collapses to zero height, so
                    growing the list is a transition rather than a jump. 0fr->1fr
                    on a grid row is the repo's own height-collapse technique
                    (contacts-list.tsx:434) — it animates to the content's real
                    height without measuring it. `inert` keeps the collapsed rows
                    out of the tab order and the accessibility tree; without it
                    they stay reachable while invisible. */}
                <div
                  id="suggestions-overflow"
                  inert={!expanded}
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-slow ease-house",
                    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  )}
                >
                  <div className="overflow-hidden">
                    <div className={cn(LIST_CLASS, "pt-2")}>
                      {overflow.map((s) => (
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
                  </div>
                </div>
                <div className="mt-auto pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground"
                    aria-expanded={expanded}
                    aria-controls="suggestions-overflow"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded
                      ? "See less"
                      : `See more${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
