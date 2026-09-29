"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RecommendationCard, type RecommendationCardData } from "@/components/radar/recommendation-card";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Two-up once the card itself is wide, the same rule as the legacy suggestions card. */
const LIST_CLASS = "space-y-2 @3xl:grid @3xl:grid-cols-2 @3xl:gap-2 @3xl:space-y-0";

/**
 * The dashboard's "Suggested outreach" slot once Radar has run for this person: the top of
 * their Radar list with the same one-click actions, and a way through to the rest.
 */
export function RadarPreviewCard({
  items,
  total,
  aiAvailable,
}: {
  items: RecommendationCardData[];
  total: number;
  aiAvailable: boolean;
}) {
  return (
    <Card className="flex h-full flex-col border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle as="h2" className="text-base">
          From Radar
        </CardTitle>
        <Link href="/radar" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          {total > items.length ? `See all ${total}` : "Open Radar"} <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="@container flex flex-1 flex-col space-y-2">
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            Nobody needs you right now. Radar checks your network again tonight.
          </p>
        ) : (
          <div className={LIST_CLASS}>
            {items.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} aiAvailable={aiAvailable} showAiPrompt={false} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
