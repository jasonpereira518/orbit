"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";
import { cn } from "@/lib/utils";

export type OutreachPerformanceItem = {
  id: string;
  name: string;
  metrics: CampaignMetrics;
};

export function OutreachPerformanceCard({
  accountRate,
  sentCount,
  positiveReplyCount,
  campaigns,
}: {
  accountRate: number | null;
  sentCount: number;
  positiveReplyCount: number;
  campaigns: OutreachPerformanceItem[];
}) {
  return (
    <Card className="flex h-full flex-col border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Outreach reply rate</CardTitle>
        <Link
          href="/outreach"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          Campaigns <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col space-y-4">
        <div>
          <div className="text-xs text-muted-foreground">Account successful reply rate</div>
          <div className="mt-1 font-[family-name:var(--font-display)] text-3xl text-primary">
            {formatReplyRate(accountRate)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {positiveReplyCount} positive / {sentCount} sent
          </p>
        </div>

        {campaigns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            No campaign sends yet. Start a reply-optimized campaign.
          </p>
        ) : (
          <div className="space-y-2">
            {campaigns.map((campaign) => (
              <Link
                key={campaign.id}
                href={`/outreach/${campaign.id}`}
                className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
              >
                <span className="truncate font-medium text-primary">
                  {campaign.name}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {formatReplyRate(campaign.metrics.successfulReplyRate)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
