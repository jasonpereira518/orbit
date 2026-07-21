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
}: {
  items: SuggestedOutreachItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PREVIEW_COUNT;
  const visible = expanded ? items : items.slice(0, PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Suggested outreach</CardTitle>
        <Link
          href="/capture"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          Capture <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent id="suggestions" className="space-y-2 scroll-mt-8">
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            No outreach opportunities — add contacts or log interactions.
          </p>
        ) : (
          <>
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
            {hasMore ? (
              <div className="pt-1">
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
