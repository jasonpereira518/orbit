"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  CampaignEditor,
  type CampaignEditorInitial,
} from "@/components/outreach/campaign-editor";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";
import type { CampaignBackgroundJob } from "@/db/schema";
import { Loader2, Sparkles } from "lucide-react";

export function OutreachCampaignCard({
  campaign,
}: {
  // No prospect list: the outreach list counts them in SQL (`metrics.prospectCount`)
  // rather than shipping every prospect to the browser to take a `.length`.
  campaign: CampaignEditorInitial & {
    updatedAt: Date;
    metrics: CampaignMetrics;
    backgroundJob?: CampaignBackgroundJob | null;
  };
}) {
  const isRunning = campaign.backgroundJob?.status === "running";

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Link href={`/outreach/${campaign.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-ink">{campaign.name}</h2>
            {isRunning && (
              <Badge className="rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30 animate-pulse flex items-center gap-1.5 px-2 py-0.5 text-[10px]">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Scouting in background
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {campaign.audienceQuery || "No audience description"}
          </p>
          {campaign.backgroundJob?.status === "completed" && campaign.backgroundJob.message && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground/90">
              <Sparkles className="h-3 w-3 text-primary shrink-0" />
              <span className="truncate">{campaign.backgroundJob.message}</span>
            </p>
          )}
        </Link>
        <div className="flex items-center gap-2">
          <CampaignEditor campaign={campaign} />
          <Badge variant="outline" className="rounded-full">{campaign.status}</Badge>
        </div>
      </div>
      <Link href={`/outreach/${campaign.id}`} className="mt-3 block">
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-ink">
            Reply rate {formatReplyRate(campaign.metrics.successfulReplyRate)}
          </span>
          <span>{campaign.metrics.sentCount} sent</span>
          <span>{campaign.metrics.positiveReplyCount} positive</span>
          <span>{campaign.metrics.awaitingReplyCount} awaiting</span>
          <span>{campaign.metrics.prospectCount} prospects</span>
          <span>
            Updated{" "}
            {formatDistanceToNow(new Date(campaign.updatedAt), {
              addSuffix: true,
            })}
          </span>
        </div>
      </Link>
    </div>
  );
}
